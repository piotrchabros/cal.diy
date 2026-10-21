import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerBotEndReason, NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { getRecallApiErrorInfo } from "../bot/recall/RecallApiClient";
import {
  buildRecallEndedEvent,
  buildRecallLifecycleEvents,
  buildRecallPassageEvents,
  buildRecallTranscriptPassages,
  findRecallTerminalStatus,
  isRecallBotDone,
  mapRecallEndReason,
} from "../bot/recall/recallEventTranslation";
import type { RecallBot, RecallRecording, RecallWebhookEnvelope } from "../bot/recall/recallSchemas";
import { RECALL_SESSION_METADATA_KEY } from "../bot/recall/recallSchemas";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type { NotetakerSessionEventService } from "./NotetakerSessionEventService";

// Only these mean a bot may still be sitting in a meeting that has no session to report into.
const ORPHAN_STOP_EVENTS = new Set([
  "bot.joining_call",
  "bot.in_waiting_room",
  "bot.in_call_not_recording",
  "bot.in_call_recording",
]);

const SYNCABLE_STATUSES = new Set<NotetakerSessionRecord["status"]>([
  "SCHEDULED",
  "WAITING_TO_BE_ADMITTED",
  "TRANSCRIBING",
]);

const TRANSCRIPT_FAILED_CODES = new Set(["failed", "error"]);

type SyncContext = { event: string; botId: string; sessionId: string };

function getErrorKind(error: unknown): string {
  return getRecallApiErrorInfo(error)?.kind ?? "UNKNOWN";
}

const RETRYABLE_RECALL_ERROR_KINDS = new Set(["NETWORK", "TIMEOUT", "RATE_LIMITED", "UNAVAILABLE"]);

// Errors that are not from the Recall client (e.g. a database blip) are retried because their cause is unknown.
function isRetryableSyncError(error: unknown): boolean {
  const info = getRecallApiErrorInfo(error);
  if (!info) return true;
  if (RETRYABLE_RECALL_ERROR_KINDS.has(info.kind)) return true;
  return info.kind === "HTTP" && info.status !== null && info.status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

function getRecordingDurationMs(recording: RecallRecording | null): number | null {
  if (!recording?.started_at || !recording.completed_at) return null;
  const durationMs = Date.parse(recording.completed_at) - Date.parse(recording.started_at);
  return Number.isNaN(durationMs) ? null : Math.max(0, durationMs);
}

function sortByStartedAt(recordings: RecallRecording[]): RecallRecording[] {
  return [...recordings].sort((a, b) => {
    const aStart = a.started_at ? Date.parse(a.started_at) : Number.POSITIVE_INFINITY;
    const bStart = b.started_at ? Date.parse(b.started_at) : Number.POSITIVE_INFINITY;
    return aStart - bStart;
  });
}

export const RECALL_HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "bot.joining_call",
  "bot.in_waiting_room",
  "bot.in_call_not_recording",
  "bot.recording_permission_allowed",
  "bot.recording_permission_denied",
  "bot.in_call_recording",
  "bot.call_ended",
  "bot.done",
  "bot.fatal",
  "recording.done",
  "recording.failed",
  "transcript.done",
  "transcript.failed",
]);

export type RecallWebhookOutcome = "IGNORED" | "ORPHAN_STOPPED" | "SYNCED";

export type RecallWebhookRetryOptions = { attempts?: number; delaysMs?: readonly number[] };

export interface IRecallWebhookServiceDeps {
  recallClient: IRecallApiClient;
  sessionRepository: INotetakerSessionRepository;
  sessionEventService: Pick<NotetakerSessionEventService, "handleEvent">;
  logger: ISimpleLogger;
}

export class RecallWebhookService {
  // Recall delivers webhooks concurrently; without this two deliveries for one bot could both see no
  // transcript and both create one, or interleave passages with the ended event.
  private readonly queues = new Map<string, Promise<void>>();

  private readonly sleep: (ms: number) => Promise<void>;

  // sleep stays out of the deps map because bindModuleToClassOnToken requires every deps key to be bound.
  constructor(
    private readonly deps: IRecallWebhookServiceDeps,
    options: { sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * The webhook is acknowledged before processing, so Recall never redelivers it; for transcript.done no
   * later webhook would repair a transient failure. Each attempt re-enters process() so the per-bot queue
   * is not held while waiting, and the sync is idempotent so re-running it is safe.
   */
  async processWithRetry(
    envelope: RecallWebhookEnvelope,
    { attempts = 4, delaysMs = DEFAULT_RETRY_DELAYS_MS }: RecallWebhookRetryOptions = {}
  ): Promise<RecallWebhookOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.process(envelope);
      } catch (error) {
        if (attempt >= attempts || !isRetryableSyncError(error)) throw error;
        const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0;
        const sessionId = envelope.data.bot?.metadata?.[RECALL_SESSION_METADATA_KEY];
        this.deps.logger.warn("Retrying a failed Recall webhook sync", {
          event: envelope.event,
          botId: envelope.data.bot?.id ?? null,
          sessionId: typeof sessionId === "string" ? sessionId : null,
          attempt,
          kind: getErrorKind(error),
        });
        await this.sleep(delayMs);
      }
    }
  }

  async process(envelope: RecallWebhookEnvelope): Promise<RecallWebhookOutcome> {
    const bot = envelope.data.bot;
    if (!RECALL_HANDLED_EVENTS.has(envelope.event) || !bot?.id) return "IGNORED";
    const sessionId = bot.metadata?.[RECALL_SESSION_METADATA_KEY];
    if (typeof sessionId !== "string") return "IGNORED";

    const context: SyncContext = { event: envelope.event, botId: bot.id, sessionId };
    const previous = this.queues.get(bot.id) ?? Promise.resolve();
    const run = previous.then(() => this.sync(context));
    // The tail swallows the outcome so one failed delivery never rejects the deliveries queued after it.
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(bot.id, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(bot.id) === tail) this.queues.delete(bot.id);
    }
  }

  private async sync(context: SyncContext): Promise<RecallWebhookOutcome> {
    const { recallClient, sessionRepository, logger } = this.deps;

    const session = await sessionRepository.findById(context.sessionId);
    if (!session) return this.stopOrphan(context);

    if (session.botProvider !== "RECALL" || (session.externalRef && session.externalRef !== context.botId)) {
      logger.warn("Recall webhook does not belong to its notetaker session", context);
      return "IGNORED";
    }
    if (!SYNCABLE_STATUSES.has(session.status)) return "IGNORED";

    const bot = await recallClient.retrieveBot(context.botId);
    if (!bot) {
      logger.warn("Recall bot from a webhook was not found", context);
      return "IGNORED";
    }

    const lifecycle = buildRecallLifecycleEvents({ sessionId: session.id, bot });
    if (!(await this.emitAll(lifecycle, context))) return "SYNCED";

    const admitted =
      lifecycle.some((event) => event.type === "session.admitted") || session.admittedAt !== null;
    if (admitted) {
      await this.syncAfterAdmission(session, bot, context);
    } else {
      await this.syncBeforeAdmission(session, bot, context);
    }
    return "SYNCED";
  }

  private async stopOrphan(context: SyncContext): Promise<RecallWebhookOutcome> {
    if (!ORPHAN_STOP_EVENTS.has(context.event)) return "IGNORED";
    try {
      const result = await this.deps.recallClient.leaveCall(context.botId);
      this.deps.logger.warn("Stopped a Recall bot whose notetaker session is gone", { ...context, result });
    } catch (error) {
      this.deps.logger.warn("Failed to stop a Recall bot whose notetaker session is gone", {
        ...context,
        kind: getErrorKind(error),
      });
    }
    return "ORPHAN_STOPPED";
  }

  private async syncBeforeAdmission(
    session: NotetakerSessionRecord,
    bot: RecallBot,
    context: SyncContext
  ): Promise<void> {
    const terminal = findRecallTerminalStatus(bot);
    if (!terminal) return;

    const endReason = mapRecallEndReason({
      code: terminal.code,
      subCode: terminal.subCode,
      admitted: false,
      stopRequested: session.stopRequestedAt !== null,
    });
    await this.emitEnded(session.id, { endReason, durationMs: 0, occurredAt: terminal.at }, context);
  }

  private async syncAfterAdmission(
    session: NotetakerSessionRecord,
    bot: RecallBot,
    context: SyncContext
  ): Promise<void> {
    const { recallClient, logger } = this.deps;
    const terminal = findRecallTerminalStatus(bot);
    const occurredAt = terminal ? new Date(terminal.at).toISOString() : new Date().toISOString();
    const mappedEndReason = terminal
      ? mapRecallEndReason({
          code: terminal.code,
          subCode: terminal.subCode,
          admitted: true,
          stopRequested: session.stopRequestedAt !== null,
        })
      : null;

    const recordings = sortByStartedAt(bot.recordings);
    if (recordings.length > 1) {
      logger.warn("Recall bot has more than one recording, using the first", {
        ...context,
        recordingCount: recordings.length,
      });
    }
    const recording = recordings[0] ?? null;
    const recordingDurationMs = getRecordingDurationMs(recording);
    const transcript = recording?.media_shortcuts?.transcript ?? null;
    const transcriptStatus = transcript?.status?.code ?? null;

    if (transcript && transcriptStatus === "done") {
      const downloadUrl =
        transcript.data?.download_url ??
        (await recallClient.retrieveTranscript(transcript.id))?.data?.download_url ??
        null;
      if (!downloadUrl) {
        logger.warn("Recall transcript is done but has no download URL yet", context);
        return;
      }

      const entries = await recallClient.downloadTranscript(downloadUrl);
      const { passages, speakerNamesAvailable, lastEndMs } = buildRecallTranscriptPassages(entries);
      const passageEvents = buildRecallPassageEvents({ sessionId: session.id, passages, occurredAt });
      if (!(await this.emitAll(passageEvents, context))) return;

      await this.emitEnded(
        session.id,
        {
          endReason: mappedEndReason ?? "MEETING_ENDED",
          durationMs: recordingDurationMs ?? lastEndMs,
          passageCount: passages.length,
          speakerNamesAvailable,
          occurredAt,
        },
        context
      );
      return;
    }

    if (transcript && transcriptStatus && TRANSCRIPT_FAILED_CODES.has(transcriptStatus)) {
      await this.emitEnded(
        session.id,
        { endReason: "INTERRUPTED", durationMs: recordingDurationMs ?? 0, occurredAt },
        context
      );
      return;
    }

    if (transcript) return;

    const recordingStatus = recording?.status?.code ?? null;
    if (recording && recordingStatus === "done") {
      // Recall allows only a few successful transcripts per recording, so one is created only while
      // the recording shows none; the per-bot queue keeps concurrent deliveries from racing this check.
      const created = await recallClient.createTranscript(recording.id, {
        provider: { recallai_async: { language_code: "auto" } },
        diarization: { use_separate_streams_when_available: true },
      });
      logger.info("Requested a Recall transcript", { ...context, transcriptId: created.id });
      return;
    }

    if (recordingStatus === "failed" || (!recording && isRecallBotDone(bot))) {
      await this.emitEnded(
        session.id,
        {
          endReason: recordingStatus === "failed" ? "INTERRUPTED" : (mappedEndReason ?? "INTERRUPTED"),
          durationMs: recordingDurationMs ?? 0,
          occurredAt,
        },
        context
      );
    }
  }

  private async emitEnded(
    sessionId: string,
    input: {
      endReason: NotetakerBotEndReason;
      durationMs: number;
      passageCount?: number;
      speakerNamesAvailable?: boolean;
      occurredAt: string;
    },
    context: SyncContext
  ): Promise<void> {
    const event = buildRecallEndedEvent({
      sessionId,
      endReason: input.endReason,
      durationMs: input.durationMs,
      passageCount: input.passageCount ?? 0,
      speakerNamesAvailable: input.speakerNamesAvailable,
      occurredAt: new Date(input.occurredAt).toISOString(),
    });
    await this.emitAll([event], context);
  }

  /** False once the session is gone, so the caller stops emitting. */
  private async emitAll(events: NotetakerBotEvent[], context: SyncContext): Promise<boolean> {
    for (const event of events) {
      const result = await this.deps.sessionEventService.handleEvent(event);
      if (result === "GONE") {
        this.deps.logger.info("Notetaker session is gone for a Recall sync", {
          ...context,
          type: event.type,
          sequence: event.sequence,
        });
        return false;
      }
    }
    return true;
  }
}
