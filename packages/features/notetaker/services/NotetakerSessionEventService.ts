import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import { canTransition, getProcessingOutcomeReason, mapOutcome } from "../lib/sessionStateMachine";
import type { INotetakerTasker } from "../lib/tasker/types";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
  NotetakerSessionUpdateInput,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type { INotetakerTranscriptRepository } from "../repositories/interfaces/INotetakerTranscriptRepository";

type PassagesEvent = Extract<NotetakerBotEvent, { type: "transcript.passages" }>;
type EndedEvent = Extract<NotetakerBotEvent, { type: "session.ended" }>;

const ACTIVE: NotetakerSessionStatusDto[] = ["SCHEDULED", "WAITING_TO_BE_ADMITTED", "TRANSCRIBING"];

function fromStatusesFor(target: NotetakerSessionStatusDto): NotetakerSessionStatusDto[] {
  return ACTIVE.filter((status) => canTransition(status, target));
}

export type NotetakerSessionEventResult = "ACCEPTED" | "DUPLICATE" | "GONE";

export interface INotetakerSessionEventServiceDeps {
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
  notetakerTasker: INotetakerTasker;
  logger: ISimpleLogger;
}

export class NotetakerSessionEventService {
  constructor(private readonly deps: INotetakerSessionEventServiceDeps) {}

  async handleEvent(event: NotetakerBotEvent): Promise<NotetakerSessionEventResult> {
    const session = await this.deps.sessionRepository.findById(event.sessionId);
    if (!session) return "GONE";

    const seq = event.sequence;

    if (seq <= session.lastEventSequence) {
      // The bot retries an ended event whose finalize enqueue failed; without this re-enqueue
      // the session would stay PROCESSING forever, because the sequence is already claimed.
      if (event.type === "session.ended" && session.status === "PROCESSING") {
        await this.enqueueFinalize(session.id);
      }
      return "DUPLICATE";
    }

    if (!ACTIVE.includes(session.status)) return "GONE";

    const at = new Date(event.occurredAt);

    switch (event.type) {
      case "session.join_requested":
        return this.applyUpdate(session.id, fromStatusesFor("WAITING_TO_BE_ADMITTED"), {
          status: "WAITING_TO_BE_ADMITTED",
          joinRequestedAt: at,
          lastEventSequence: seq,
        });
      case "session.admitted":
        return this.applyUpdate(session.id, fromStatusesFor("TRANSCRIBING"), {
          status: "TRANSCRIBING",
          admittedAt: at,
          lastEventSequence: seq,
        });
      case "session.notice_posted":
        return this.applyUpdate(session.id, ACTIVE, { noticePostedAt: at, lastEventSequence: seq });
      case "session.heartbeat":
        // App clock, not the bot's occurredAt: the watchdog compares this with the app clock.
        return this.applyUpdate(session.id, ACTIVE, {
          lastHeartbeatAt: new Date(),
          lastEventSequence: seq,
        });
      case "session.reconnecting":
        return this.applyUpdate(session.id, ["TRANSCRIBING"], {
          rejoinAttempted: true,
          interruptedAtMs: event.data.atMs,
          lastEventSequence: seq,
        });
      case "transcript.passages":
        return this.handlePassages(session, event);
      case "session.ended":
        if (session.admittedAt !== null) return this.handleEndedAfterAdmission(session, event, at);
        return this.handleEndedBeforeAdmission(session, event, at);
    }
  }

  private async applyUpdate(
    sessionId: string,
    fromStatuses: NotetakerSessionStatusDto[],
    data: NotetakerSessionUpdateInput
  ): Promise<NotetakerSessionEventResult> {
    const updated = await this.deps.sessionRepository.updateIfStatusIn(sessionId, fromStatuses, data);
    if (!updated) return "GONE";
    return "ACCEPTED";
  }

  private async handlePassages(
    session: NotetakerSessionRecord,
    event: PassagesEvent
  ): Promise<NotetakerSessionEventResult> {
    if (session.status !== "TRANSCRIBING") return "GONE";

    const transcript = await this.deps.transcriptRepository.createIfMissing({
      sessionId: session.id,
      bookingId: session.bookingId,
    });
    // Inserted before the sequence is claimed: claiming it first would turn a retry after a
    // failed insert into a duplicate and lose the passages.
    await this.deps.transcriptRepository.insertPassages(transcript.id, event.data.passages);

    return this.applyUpdate(session.id, ["TRANSCRIBING"], { lastEventSequence: event.sequence });
  }

  private async handleEndedAfterAdmission(
    session: NotetakerSessionRecord,
    event: EndedEvent,
    at: Date
  ): Promise<NotetakerSessionEventResult> {
    const { endReason, durationMs, interruptedAtMs, passageCount } = event.data;

    const updated = await this.deps.sessionRepository.updateIfStatusIn(
      session.id,
      fromStatusesFor("PROCESSING"),
      {
        status: "PROCESSING",
        outcomeReason: getProcessingOutcomeReason(endReason),
        endedAt: at,
        interruptedAtMs,
        lastEventSequence: event.sequence,
      }
    );
    if (!updated) return "GONE";

    const transcript = await this.deps.transcriptRepository.findBySessionId(session.id);
    if (transcript) {
      await this.deps.transcriptRepository.update(transcript.id, { durationMs, passageCount });
    }

    const outcome = mapOutcome({ cause: endReason, admitted: true, passageCount });
    if (outcome.kind === "OUTCOME" && outcome.normalised) {
      this.deps.logger.warn("Notetaker session ended with an end reason unexpected after admission", {
        sessionId: session.id,
        endReason,
        sequence: event.sequence,
        status: outcome.status,
      });
    }

    await this.enqueueFinalize(session.id);
    return "ACCEPTED";
  }

  private async handleEndedBeforeAdmission(
    session: NotetakerSessionRecord,
    event: EndedEvent,
    at: Date
  ): Promise<NotetakerSessionEventResult> {
    const { endReason } = event.data;
    const outcome = mapOutcome({ cause: endReason, admitted: false, passageCount: 0 });

    if (outcome.kind === "DELETE_SESSION") {
      await this.deps.sessionRepository.deleteById(session.id);
      return "ACCEPTED";
    }

    const updated = await this.deps.sessionRepository.updateIfStatusIn(
      session.id,
      fromStatusesFor("FAILED"),
      {
        status: outcome.status,
        outcomeReason: outcome.outcomeReason,
        endedAt: at,
        lastEventSequence: event.sequence,
      }
    );
    if (!updated) return "GONE";

    if (outcome.normalised) {
      this.deps.logger.warn("Notetaker session ended with an end reason unexpected before admission", {
        sessionId: session.id,
        endReason,
        sequence: event.sequence,
        status: outcome.status,
      });
    }

    return "ACCEPTED";
  }

  private async enqueueFinalize(sessionId: string): Promise<void> {
    const { runId } = await this.deps.notetakerTasker.finalizeSession({ sessionId });
    if (runId !== "task-failed") return;

    this.deps.logger.error("Failed to enqueue notetaker session finalize", { sessionId });
    throw ErrorWithCode.Factory.InternalServerError(
      `Unable to enqueue finalize for notetaker session ${sessionId}`
    );
  }
}
