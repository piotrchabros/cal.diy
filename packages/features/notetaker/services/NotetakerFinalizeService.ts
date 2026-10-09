import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getEndCauseFromProcessingOutcomeReason, mapOutcome } from "../lib/sessionStateMachine";
import type { INotetakerTasker } from "../lib/tasker/types";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";
import type {
  INotetakerTranscriptRepository,
  NotetakerPassageRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";

export interface INotetakerFinalizeServiceDeps {
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
  notetakerTasker: INotetakerTasker;
  logger: ISimpleLogger;
}

export function getDurationWeightedLanguage(
  passages: Pick<NotetakerPassageRecord, "startMs" | "endMs" | "language">[]
): string | null {
  const weightByLanguage = new Map<string, number>();
  for (const passage of passages) {
    if (!passage.language) continue;
    const weight = Math.max(passage.endMs - passage.startMs, 0);
    weightByLanguage.set(passage.language, (weightByLanguage.get(passage.language) ?? 0) + weight);
  }

  let bestLanguage: string | null = null;
  let bestWeight = -1;
  for (const [language, weight] of Array.from(weightByLanguage.entries())) {
    if (weight > bestWeight) {
      bestLanguage = language;
      bestWeight = weight;
    }
  }
  return bestLanguage;
}

export class NotetakerFinalizeService {
  constructor(private readonly deps: INotetakerFinalizeServiceDeps) {}

  async finalize(params: { sessionId: string }): Promise<void> {
    const { sessionId } = params;
    const { sessionRepository, transcriptRepository, notetakerTasker, logger } = this.deps;

    const session = await sessionRepository.findById(sessionId);
    if (!session || session.status !== "PROCESSING") return;

    const transcript = await transcriptRepository.findBySessionId(sessionId);
    let passageCount = 0;
    if (transcript) passageCount = await transcriptRepository.countPassages(transcript.id);

    if (transcript && transcript.passageCount > 0 && transcript.passageCount !== passageCount) {
      logger.warn("Notetaker reported passage count differs from stored passages", {
        sessionId,
        reportedPassageCount: transcript.passageCount,
        storedPassageCount: passageCount,
      });
    }

    const cause = getEndCauseFromProcessingOutcomeReason(session.outcomeReason);
    const outcome = mapOutcome({ cause, admitted: true, passageCount });
    // Unreachable with admitted: true; narrows the union.
    if (outcome.kind !== "OUTCOME") return;

    const endedAt = session.endedAt ?? new Date();
    const finalState = { status: outcome.status, outcomeReason: outcome.outcomeReason, endedAt };

    if (!transcript || passageCount === 0) {
      // Deleting first: the other order can leave a FAILED session with an empty transcript after a crash,
      // whereas a retry after this order still finds the session in PROCESSING.
      if (transcript) await transcriptRepository.deleteById(transcript.id);
      await sessionRepository.updateIfStatusIn(session.id, ["PROCESSING"], finalState);
      return;
    }

    const language = getDurationWeightedLanguage(await transcriptRepository.findAllPassages(transcript.id));
    // A positive stored duration is the one carried by the end event; 0 means none was reported.
    let durationMs = transcript.durationMs;
    if (durationMs <= 0) {
      durationMs = (await transcriptRepository.findLastPassageEndMs(transcript.id)) ?? 0;
    }
    await transcriptRepository.update(transcript.id, {
      language,
      passageCount,
      durationMs,
      completeness: outcome.completeness ?? transcript.completeness,
    });

    const updated = await sessionRepository.updateIfStatusIn(session.id, ["PROCESSING"], finalState);
    if (!updated) return;

    if (outcome.status !== "READY" && outcome.status !== "ENDED_EARLY") return;

    const result = await notetakerTasker.sendNotification(
      { kind: "RESULTS_READY", bookingId: session.bookingId, sessionId },
      { idempotencyKey: `notetaker:RESULTS_READY:${sessionId}` }
    );
    if (result.runId === "task-failed") {
      logger.error("Failed to enqueue the notetaker results notification", {
        sessionId,
        bookingId: session.bookingId,
      });
    }
  }
}
