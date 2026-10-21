import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { describe, expect, it, vi } from "vitest";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { createRecallApiError } from "../bot/recall/RecallApiClient";
import { RECALL_EVENT_SEQUENCE } from "../bot/recall/recallEventTranslation";
import type {
  RecallBot,
  RecallCreateTranscriptRequest,
  RecallRecording,
  RecallStatusChange,
  RecallTranscriptArtifact,
  RecallTranscriptEntry,
  RecallWebhookEnvelope,
} from "../bot/recall/recallSchemas";
import { getProcessingOutcomeReason } from "../lib/sessionStateMachine";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { NotetakerSessionUpdateInput } from "../repositories/interfaces/INotetakerSessionRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerSessionEventService } from "./NotetakerSessionEventService";
import { RecallWebhookService } from "./RecallWebhookService";

const BOOKING_ID = 100;
const ORGANIZER_ID = 1;
const BOT_ID = "bot-1";
const RECORDING_ID = "recording-1";
const TRANSCRIPT_ID = "transcript-1";
const DOWNLOAD_URL = "https://download.example.com/transcript?signature=secret";

const JOINING_AT = "2026-10-12T10:00:00.000Z";
const WAITING_AT = "2026-10-12T10:00:10.000Z";
const IN_CALL_AT = "2026-10-12T10:01:00.000Z";
const CALL_ENDED_AT = "2026-10-12T10:31:00.000Z";
const DONE_AT = "2026-10-12T10:32:00.000Z";
const RECORDING_STARTED_AT = "2026-10-12T10:01:00.000Z";
const RECORDING_COMPLETED_AT = "2026-10-12T10:31:00.000Z";
const RECORDING_DURATION_MS = 30 * 60 * 1000;

function buildBooking(): InMemoryBookingSeed {
  return {
    id: BOOKING_ID,
    uid: "booking-uid-1",
    userId: ORGANIZER_ID,
    status: "ACCEPTED",
    startTime: new Date("2026-10-12T10:00:00.000Z"),
    endTime: new Date("2026-10-12T10:30:00.000Z"),
    title: "Planning call",
    location: null,
    metadata: null,
    recurringEventId: null,
    eventTypeId: 10,
    attendeeEmails: ["attendee@example.com"],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: "organizer@example.com", locale: "en" },
  };
}

class RecordingTasker implements INotetakerTasker {
  finalizeCalls: NotetakerFinalizeSessionPayload[] = [];
  notificationCalls: NotetakerSendNotificationPayload[] = [];

  async finalizeSession(payload: NotetakerFinalizeSessionPayload): Promise<{ runId: string }> {
    this.finalizeCalls.push(payload);
    return { runId: "run-1" };
  }

  async generateSummary(_payload: NotetakerGenerateSummaryPayload): Promise<{ runId: string }> {
    return { runId: "summary-run" };
  }

  async sendNotification(payload: NotetakerSendNotificationPayload): Promise<{ runId: string }> {
    this.notificationCalls.push(payload);
    return { runId: "notification-run" };
  }
}

class FakeRecallClient implements IRecallApiClient {
  readonly bots = new Map<string, RecallBot>();
  readonly downloads = new Map<string, RecallTranscriptEntry[]>();
  readonly transcripts = new Map<string, RecallTranscriptArtifact>();
  retrieveBotCalls: string[] = [];
  createTranscriptCalls: { recordingId: string; body: RecallCreateTranscriptRequest }[] = [];
  downloadCalls: string[] = [];
  leaveCallCalls: string[] = [];
  retrieveBotError: Error | null = null;
  leaveCallError: Error | null = null;
  downloadErrors: Error[] = [];

  async createBot(): Promise<RecallBot> {
    throw new Error("createBot is not used by the webhook service");
  }

  async retrieveBot(botId: string): Promise<RecallBot | null> {
    this.retrieveBotCalls.push(botId);
    // A real round trip yields, which is what lets concurrent deliveries interleave without the queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.retrieveBotError) {
      const error = this.retrieveBotError;
      this.retrieveBotError = null;
      throw error;
    }
    const bot = this.bots.get(botId);
    return bot ? structuredClone(bot) : null;
  }

  async listBotsByMetadata(): Promise<RecallBot[]> {
    return [];
  }

  async leaveCall(botId: string): Promise<"OK" | "NOT_FOUND" | "NOT_IN_CALL"> {
    this.leaveCallCalls.push(botId);
    if (this.leaveCallError) throw this.leaveCallError;
    return "OK";
  }

  async deleteScheduledBot(): Promise<"OK" | "NOT_FOUND" | "NOT_DELETABLE"> {
    return "OK";
  }

  async createTranscript(recordingId: string, body: RecallCreateTranscriptRequest): Promise<{ id: string }> {
    this.createTranscriptCalls.push({ recordingId, body });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const bot of Array.from(this.bots.values())) {
      const recording = bot.recordings.find((candidate) => candidate.id === recordingId);
      if (recording) {
        recording.media_shortcuts = {
          transcript: { id: TRANSCRIPT_ID, status: { code: "processing" }, data: null },
        };
      }
    }
    return { id: TRANSCRIPT_ID };
  }

  async retrieveTranscript(transcriptId: string): Promise<RecallTranscriptArtifact | null> {
    return this.transcripts.get(transcriptId) ?? null;
  }

  async downloadTranscript(downloadUrl: string): Promise<RecallTranscriptEntry[]> {
    this.downloadCalls.push(downloadUrl);
    const queuedError = this.downloadErrors.shift();
    if (queuedError) throw queuedError;
    const entries = this.downloads.get(downloadUrl);
    if (!entries) throw new Error("Unknown download URL");
    return entries;
  }
}

function status(code: string, createdAt: string, subCode: string | null = null): RecallStatusChange {
  return { code, sub_code: subCode, created_at: createdAt };
}

function admittedChanges(): RecallStatusChange[] {
  return [
    status("joining_call", JOINING_AT),
    status("in_waiting_room", WAITING_AT),
    status("in_call_recording", IN_CALL_AT),
  ];
}

function endedChanges(subCode = "call_ended_by_host"): RecallStatusChange[] {
  return [...admittedChanges(), status("call_ended", CALL_ENDED_AT, subCode), status("done", DONE_AT)];
}

function recording(overrides: Partial<RecallRecording> = {}): RecallRecording {
  return {
    id: RECORDING_ID,
    started_at: RECORDING_STARTED_AT,
    completed_at: RECORDING_COMPLETED_AT,
    status: { code: "done" },
    media_shortcuts: null,
    ...overrides,
  };
}

function doneTranscriptRecording(): RecallRecording {
  return recording({
    media_shortcuts: {
      transcript: { id: TRANSCRIPT_ID, status: { code: "done" }, data: { download_url: DOWNLOAD_URL } },
    },
  });
}

function entries(count: number): RecallTranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    participant: { id: index % 2, name: index % 2 === 0 ? "Alice" : "Bob" },
    language_code: "en",
    words: [
      { text: "hello", start_timestamp: { relative: index }, end_timestamp: { relative: index + 0.4 } },
      { text: "there", start_timestamp: { relative: index + 0.5 }, end_timestamp: { relative: index + 0.9 } },
    ],
  }));
}

function webhook(event: string, sessionId: string | null, botId: string = BOT_ID): RecallWebhookEnvelope {
  return {
    event,
    data: {
      bot: { id: botId, metadata: sessionId === null ? {} : { notetakerSessionId: sessionId } },
    },
  };
}

function setup() {
  const repositories = createInMemoryNotetakerRepositories();
  repositories.store.addBooking(buildBooking());
  const tasker = new RecordingTasker();
  const logger: ISimpleLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sessionEventService = new NotetakerSessionEventService({
    sessionRepository: repositories.sessionRepository,
    transcriptRepository: repositories.transcriptRepository,
    bookingNotetakerRepository: repositories.bookingNotetakerRepository,
    activityRepository: repositories.activityRepository,
    notetakerTasker: tasker,
    logger,
  });
  const recallClient = new FakeRecallClient();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const service = new RecallWebhookService(
    {
      recallClient,
      sessionRepository: repositories.sessionRepository,
      sessionEventService,
      logger,
    },
    { sleep }
  );

  async function seedSession(patch: NotetakerSessionUpdateInput = {}): Promise<string> {
    const session = await repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "RECALL",
      displayName: "Cal.diy Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
    });
    await repositories.sessionRepository.update(session.id, { externalRef: BOT_ID, ...patch });
    return session.id;
  }

  function sessionOf(sessionId: string) {
    const session = repositories.store.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} is missing from the store`);
    return { ...session };
  }

  function transcriptOf(sessionId: string) {
    const transcript = Array.from(repositories.store.transcripts.values()).find(
      (candidate) => candidate.sessionId === sessionId
    );
    return transcript ? { ...transcript } : null;
  }

  function storedPassageCount(sessionId: string): number {
    const transcript = transcriptOf(sessionId);
    if (!transcript) return 0;
    return repositories.store.passages.get(transcript.id)?.size ?? 0;
  }

  function setBot(bot: Partial<RecallBot>): void {
    recallClient.bots.set(BOT_ID, { id: BOT_ID, status_changes: [], recordings: [], metadata: null, ...bot });
  }

  return {
    repositories,
    tasker,
    logger,
    recallClient,
    service,
    sleep,
    seedSession,
    sessionOf,
    transcriptOf,
    storedPassageCount,
    setBot,
  };
}

describe("RecallWebhookService", () => {
  describe("ignored deliveries", () => {
    it("ignores an event it does not handle", async () => {
      const { service, seedSession, recallClient } = setup();
      const sessionId = await seedSession();

      await expect(service.process(webhook("bot.output_log", sessionId))).resolves.toBe("IGNORED");
      expect(recallClient.retrieveBotCalls).toEqual([]);
    });

    it("ignores a bot without the session id in its metadata", async () => {
      const { service, recallClient } = setup();

      await expect(service.process(webhook("bot.call_ended", null))).resolves.toBe("IGNORED");
      expect(recallClient.retrieveBotCalls).toEqual([]);
    });

    it("ignores an envelope without a bot", async () => {
      const { service } = setup();

      await expect(
        service.process({ event: "recording.done", data: { recording: { id: "r" } } })
      ).resolves.toBe("IGNORED");
    });

    it("ignores a session of another provider", async () => {
      const { service, seedSession, recallClient, logger } = setup();
      const sessionId = await seedSession({ botProvider: "SELF_HOSTED" });

      await expect(service.process(webhook("bot.in_call_recording", sessionId))).resolves.toBe("IGNORED");
      expect(recallClient.retrieveBotCalls).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("ignores a bot that is not the session's external ref", async () => {
      const { service, seedSession, recallClient, sessionOf } = setup();
      const sessionId = await seedSession({ externalRef: "another-bot" });
      const before = sessionOf(sessionId);

      await expect(service.process(webhook("bot.in_call_recording", sessionId))).resolves.toBe("IGNORED");
      expect(recallClient.retrieveBotCalls).toEqual([]);
      expect(sessionOf(sessionId)).toEqual(before);
    });

    it("ignores a session that is no longer live", async () => {
      const { service, seedSession, recallClient } = setup();
      const sessionId = await seedSession({ status: "READY" });

      await expect(service.process(webhook("transcript.done", sessionId))).resolves.toBe("IGNORED");
      expect(recallClient.retrieveBotCalls).toEqual([]);
    });

    it("ignores a bot Recall no longer knows", async () => {
      const { service, seedSession } = setup();
      const sessionId = await seedSession();

      await expect(service.process(webhook("bot.in_call_recording", sessionId))).resolves.toBe("IGNORED");
    });
  });

  describe("orphan bots", () => {
    it("asks a bot whose session is gone to leave the call", async () => {
      const { service, recallClient } = setup();

      await expect(service.process(webhook("bot.in_call_recording", "missing-session"))).resolves.toBe(
        "ORPHAN_STOPPED"
      );
      expect(recallClient.leaveCallCalls).toEqual([BOT_ID]);
    });

    it("still reports the orphan stopped when leaving the call fails", async () => {
      const { service, recallClient, logger } = setup();
      recallClient.leaveCallError = createRecallApiError("UNAVAILABLE", "POST /bot/{id}/leave_call/ 503", {
        status: 503,
      });

      await expect(service.process(webhook("bot.in_waiting_room", "missing-session"))).resolves.toBe(
        "ORPHAN_STOPPED"
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ botId: BOT_ID, kind: "UNAVAILABLE" })
      );
    });

    it("ignores an orphan bot that has already left", async () => {
      const { service, recallClient } = setup();

      await expect(service.process(webhook("bot.done", "missing-session"))).resolves.toBe("IGNORED");
      expect(recallClient.leaveCallCalls).toEqual([]);
    });
  });

  describe("lifecycle", () => {
    it("moves a scheduled session through the waiting room into transcribing", async () => {
      const { service, seedSession, setBot, sessionOf, tasker } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: admittedChanges() });

      await expect(service.process(webhook("bot.in_call_recording", sessionId))).resolves.toBe("SYNCED");

      const session = sessionOf(sessionId);
      expect(session.status).toBe("TRANSCRIBING");
      expect(session.joinRequestedAt).toEqual(new Date(WAITING_AT));
      expect(session.admittedAt).toEqual(new Date(IN_CALL_AT));
      expect(session.noticePostedAt).toEqual(new Date(IN_CALL_AT));
      expect(session.lastEventSequence).toBe(RECALL_EVENT_SEQUENCE.NOTICE_POSTED);
      expect(tasker.notificationCalls).toEqual([
        expect.objectContaining({ kind: "ADMIT_PROMPT", sessionId }),
      ]);
    });

    it("treats a waiting room webhook that arrives after admission as a replay", async () => {
      const { service, seedSession, setBot, sessionOf } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: admittedChanges() });
      await service.process(webhook("bot.in_call_recording", sessionId));
      const before = sessionOf(sessionId);

      await expect(service.process(webhook("bot.in_waiting_room", sessionId))).resolves.toBe("SYNCED");

      expect(sessionOf(sessionId)).toEqual(before);
    });

    it("repairs a lost admitted webhook from the bot's status history", async () => {
      const { service, seedSession, setBot, sessionOf } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: [...admittedChanges(), status("call_ended", CALL_ENDED_AT, "call_ended_by_host")],
      });

      await service.process(webhook("bot.call_ended", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("TRANSCRIBING");
      expect(session.admittedAt).toEqual(new Date(IN_CALL_AT));
    });
  });

  describe("before admission", () => {
    it("fails a session the bot was never admitted to", async () => {
      const { service, seedSession, setBot, sessionOf } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: [
          status("joining_call", JOINING_AT),
          status("in_waiting_room", WAITING_AT),
          status("call_ended", CALL_ENDED_AT, "timeout_exceeded_waiting_room"),
        ],
      });

      await service.process(webhook("bot.call_ended", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("FAILED");
      expect(session.outcomeReason).toBe("NOT_ADMITTED");
      expect(session.endedAt).toEqual(new Date(CALL_ENDED_AT));
    });

    it("fails with an unusable link when the bot cannot find the meeting", async () => {
      const { service, seedSession, setBot, sessionOf } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: [
          status("joining_call", JOINING_AT),
          status("fatal", CALL_ENDED_AT, "meeting_not_found"),
        ],
      });

      await service.process(webhook("bot.fatal", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("FAILED");
      expect(session.outcomeReason).toBe("MEETING_LINK_UNUSABLE");
    });

    it("deletes the session when the host stopped the bot before admission", async () => {
      const { service, seedSession, setBot, repositories } = setup();
      const sessionId = await seedSession({ stopRequestedAt: new Date(WAITING_AT) });
      setBot({
        status_changes: [
          status("joining_call", JOINING_AT),
          status("call_ended", CALL_ENDED_AT, "bot_received_leave_call"),
        ],
      });

      await service.process(webhook("bot.call_ended", sessionId));

      expect(repositories.store.sessions.has(sessionId)).toBe(false);
    });

    it("waits while the bot is still joining", async () => {
      const { service, seedSession, setBot, sessionOf } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: [status("joining_call", JOINING_AT)] });

      await expect(service.process(webhook("bot.joining_call", sessionId))).resolves.toBe("SYNCED");

      expect(sessionOf(sessionId).status).toBe("SCHEDULED");
    });
  });

  describe("after admission", () => {
    it("requests a transcript, then ingests it and hands the session to finalize", async () => {
      const {
        service,
        seedSession,
        setBot,
        sessionOf,
        tasker,
        recallClient,
        storedPassageCount,
        transcriptOf,
      } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: endedChanges(), recordings: [recording()] });

      await expect(service.process(webhook("recording.done", sessionId))).resolves.toBe("SYNCED");

      expect(recallClient.createTranscriptCalls).toEqual([
        {
          recordingId: RECORDING_ID,
          body: {
            provider: { recallai_async: { language_code: "auto" } },
            diarization: { use_separate_streams_when_available: true },
          },
        },
      ]);
      expect(sessionOf(sessionId).status).toBe("TRANSCRIBING");

      setBot({ status_changes: endedChanges(), recordings: [doneTranscriptRecording()] });
      recallClient.downloads.set(DOWNLOAD_URL, entries(3));

      await expect(service.process(webhook("transcript.done", sessionId))).resolves.toBe("SYNCED");

      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe(getProcessingOutcomeReason("MEETING_ENDED"));
      expect(session.endedAt).toEqual(new Date(CALL_ENDED_AT));
      expect(session.lastEventSequence).toBe(RECALL_EVENT_SEQUENCE.ENDED);
      expect(storedPassageCount(sessionId)).toBe(3);
      expect(transcriptOf(sessionId)).toMatchObject({
        durationMs: RECORDING_DURATION_MS,
        passageCount: 3,
        speakerNamesAvailable: true,
      });
      expect(tasker.finalizeCalls).toEqual([{ sessionId }]);
    });

    it("downloads through the transcript artifact when the shortcut has no URL", async () => {
      const { service, seedSession, setBot, sessionOf, recallClient } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: endedChanges(),
        recordings: [
          recording({
            media_shortcuts: { transcript: { id: TRANSCRIPT_ID, status: { code: "done" }, data: null } },
          }),
        ],
      });
      recallClient.transcripts.set(TRANSCRIPT_ID, {
        id: TRANSCRIPT_ID,
        status: { code: "done" },
        data: { download_url: DOWNLOAD_URL },
      });
      recallClient.downloads.set(DOWNLOAD_URL, entries(1));

      await service.process(webhook("transcript.done", sessionId));

      expect(recallClient.downloadCalls).toEqual([DOWNLOAD_URL]);
      expect(sessionOf(sessionId).status).toBe("PROCESSING");
    });

    it("does not download again for a transcript webhook replayed after processing", async () => {
      const { service, seedSession, setBot, recallClient, tasker } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: endedChanges(), recordings: [doneTranscriptRecording()] });
      recallClient.downloads.set(DOWNLOAD_URL, entries(2));
      await service.process(webhook("transcript.done", sessionId));

      await expect(service.process(webhook("transcript.done", sessionId))).resolves.toBe("IGNORED");

      expect(recallClient.downloadCalls).toEqual([DOWNLOAD_URL]);
      expect(tasker.finalizeCalls).toHaveLength(1);
    });

    it("does not create a second transcript while one is processing", async () => {
      const { service, seedSession, setBot, recallClient } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: endedChanges(),
        recordings: [
          recording({
            media_shortcuts: {
              transcript: { id: TRANSCRIPT_ID, status: { code: "processing" }, data: null },
            },
          }),
        ],
      });

      await expect(service.process(webhook("recording.done", sessionId))).resolves.toBe("SYNCED");

      expect(recallClient.createTranscriptCalls).toEqual([]);
    });

    it("creates one transcript for two concurrent deliveries of the same bot", async () => {
      const { service, seedSession, setBot, recallClient } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: endedChanges(), recordings: [recording()] });

      await Promise.all([
        service.process(webhook("recording.done", sessionId)),
        service.process(webhook("bot.done", sessionId)),
      ]);

      expect(recallClient.createTranscriptCalls).toHaveLength(1);
    });

    it("splits a long transcript into passage events of at most 50", async () => {
      const { service, seedSession, setBot, sessionOf, recallClient, storedPassageCount, transcriptOf } =
        setup();
      const sessionId = await seedSession();
      setBot({ status_changes: endedChanges(), recordings: [doneTranscriptRecording()] });
      recallClient.downloads.set(DOWNLOAD_URL, entries(120));

      await service.process(webhook("transcript.done", sessionId));

      expect(storedPassageCount(sessionId)).toBe(120);
      expect(transcriptOf(sessionId)?.passageCount).toBe(120);
      expect(sessionOf(sessionId).status).toBe("PROCESSING");
    });

    it("ends interrupted when the transcript fails", async () => {
      const { service, seedSession, setBot, sessionOf, recallClient, tasker } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: endedChanges(),
        recordings: [
          recording({
            media_shortcuts: { transcript: { id: TRANSCRIPT_ID, status: { code: "failed" }, data: null } },
          }),
        ],
      });

      await service.process(webhook("transcript.failed", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe(getProcessingOutcomeReason("INTERRUPTED"));
      expect(recallClient.downloadCalls).toEqual([]);
      expect(tasker.finalizeCalls).toEqual([{ sessionId }]);
    });

    it("ends interrupted when the recording fails", async () => {
      const { service, seedSession, setBot, sessionOf } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: endedChanges(), recordings: [recording({ status: { code: "failed" } })] });

      await service.process(webhook("recording.failed", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe(getProcessingOutcomeReason("INTERRUPTED"));
    });

    it("ends as removed by a participant when the bot was kicked before recording", async () => {
      const { service, seedSession, setBot, sessionOf, repositories } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: [
          status("joining_call", JOINING_AT),
          status("in_call_not_recording", IN_CALL_AT),
          status("call_ended", CALL_ENDED_AT, "bot_kicked_from_call"),
          status("done", DONE_AT),
        ],
      });

      await service.process(webhook("bot.done", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe(getProcessingOutcomeReason("REMOVED_BY_PARTICIPANT"));
      expect(repositories.store.activities).toEqual([
        expect.objectContaining({ sessionId, action: "STOPPED", actorType: "PARTICIPANT" }),
      ]);
    });

    it("ends as stopped by the host when the host asked the bot to leave", async () => {
      const { service, seedSession, setBot, sessionOf, recallClient } = setup();
      const sessionId = await seedSession({ stopRequestedAt: new Date(IN_CALL_AT) });
      setBot({
        status_changes: endedChanges("bot_received_leave_call"),
        recordings: [doneTranscriptRecording()],
      });
      recallClient.downloads.set(DOWNLOAD_URL, entries(2));

      await service.process(webhook("transcript.done", sessionId));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe(getProcessingOutcomeReason("STOP_REQUESTED"));
    });

    it("waits while the bot is still in the call", async () => {
      const { service, seedSession, setBot, sessionOf, recallClient } = setup();
      const sessionId = await seedSession();
      setBot({
        status_changes: admittedChanges(),
        recordings: [recording({ status: { code: "processing" } })],
      });

      await service.process(webhook("bot.in_call_recording", sessionId));

      expect(sessionOf(sessionId).status).toBe("TRANSCRIBING");
      expect(recallClient.createTranscriptCalls).toEqual([]);
    });
  });

  describe("per-bot queue", () => {
    it("keeps processing later deliveries after one fails and releases the queue entry", async () => {
      const { service, seedSession, setBot, sessionOf, recallClient } = setup();
      const sessionId = await seedSession();
      setBot({ status_changes: admittedChanges() });
      recallClient.retrieveBotError = new Error("socket hang up");

      const results = await Promise.allSettled([
        service.process(webhook("bot.in_waiting_room", sessionId)),
        service.process(webhook("bot.in_call_recording", sessionId)),
      ]);

      expect(results[0].status).toBe("rejected");
      expect(results[1]).toEqual({ status: "fulfilled", value: "SYNCED" });
      expect(sessionOf(sessionId).status).toBe("TRANSCRIBING");
      expect(service["queues"].size).toBe(0);
    });
  });

  describe("processWithRetry", () => {
    function transcriptDoneSetup() {
      const context = setup();
      context.setBot({ status_changes: endedChanges(), recordings: [doneTranscriptRecording()] });
      context.recallClient.downloads.set(DOWNLOAD_URL, entries(3));
      return context;
    }

    it("retries a transient failure and then syncs the transcript", async () => {
      const { service, sleep, seedSession, sessionOf, recallClient, storedPassageCount, logger } =
        transcriptDoneSetup();
      const sessionId = await seedSession();
      recallClient.downloadErrors = [
        createRecallApiError("TIMEOUT", "GET transcript download timed out after 30000ms"),
        createRecallApiError("HTTP", "GET transcript download failed with status 502", { status: 502 }),
      ];

      await expect(service.processWithRetry(webhook("transcript.done", sessionId))).resolves.toBe("SYNCED");

      expect(recallClient.downloadCalls).toHaveLength(3);
      expect(sleep.mock.calls).toEqual([[5_000], [30_000]]);
      expect(sessionOf(sessionId).status).toBe("PROCESSING");
      expect(storedPassageCount(sessionId)).toBe(3);
      expect(logger.warn).toHaveBeenCalledWith("Retrying a failed Recall webhook sync", {
        event: "transcript.done",
        botId: BOT_ID,
        sessionId,
        attempt: 1,
        kind: "TIMEOUT",
      });
      expect(service["queues"].size).toBe(0);
    });

    it("retries an error that is not from the Recall client", async () => {
      const { service, sleep, seedSession, sessionOf, recallClient } = transcriptDoneSetup();
      const sessionId = await seedSession();
      recallClient.retrieveBotError = new Error("Connection terminated unexpectedly");

      await expect(service.processWithRetry(webhook("transcript.done", sessionId))).resolves.toBe("SYNCED");

      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sessionOf(sessionId).status).toBe("PROCESSING");
    });

    it.each([
      ["a bad request", createRecallApiError("BAD_REQUEST", "POST transcript failed with status 400")],
      ["an invalid response", createRecallApiError("INVALID_RESPONSE", "GET bot returned an invalid body")],
      ["a 4xx", createRecallApiError("HTTP", "GET bot failed with status 403", { status: 403 })],
    ])("does not retry %s", async (_label, error) => {
      const { service, sleep, seedSession, recallClient } = transcriptDoneSetup();
      const sessionId = await seedSession();
      recallClient.retrieveBotError = error;

      await expect(service.processWithRetry(webhook("transcript.done", sessionId))).rejects.toBe(error);

      expect(recallClient.retrieveBotCalls).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("gives up after the maximum attempts and rethrows the last error", async () => {
      const { service, sleep, seedSession, sessionOf, recallClient, logger } = transcriptDoneSetup();
      const sessionId = await seedSession();
      const lastError = createRecallApiError(
        "UNAVAILABLE",
        "GET transcript download failed after 4 attempts"
      );
      recallClient.downloadErrors = [
        createRecallApiError("NETWORK", "GET transcript download failed with TypeError"),
        createRecallApiError("RATE_LIMITED", "GET transcript download failed with status 429"),
        createRecallApiError("TIMEOUT", "GET transcript download timed out after 30000ms"),
        lastError,
      ];

      await expect(service.processWithRetry(webhook("transcript.done", sessionId))).rejects.toBe(lastError);

      expect(recallClient.downloadCalls).toHaveLength(4);
      expect(sleep.mock.calls).toEqual([[5_000], [30_000], [120_000]]);
      expect(sessionOf(sessionId).status).toBe("TRANSCRIBING");
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(DOWNLOAD_URL);
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("signature=secret");
    });
  });
});
