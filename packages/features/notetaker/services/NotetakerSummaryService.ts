import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import { notetakerSummaryContentSchema } from "@calcom/lib/dto/NotetakerSummaryDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerConfig } from "../lib/config";
import { toNotetakerSummaryDto } from "../lib/summaryDto";
import type { INotetakerTasker, NotetakerGenerateSummaryPayload } from "../lib/tasker/types";
import { countTranscriptWords } from "../lib/transcriptWords";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";
import type { INotetakerSummaryRepository } from "../repositories/interfaces/INotetakerSummaryRepository";
import type {
  INotetakerTranscriptRepository,
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import type {
  INotetakerSummaryGenerator,
  NotetakerSummaryFailureCode,
  NotetakerSummaryResult,
} from "../summary/INotetakerSummaryGenerator";
import type { NotetakerAccessService } from "./NotetakerAccessService";

type NotetakerSummaryFailure = { failureCode: NotetakerSummaryFailureCode; retryable: boolean };

// Mirrors retry.maxAttempts in lib/tasker/trigger/config.ts: the task is retried only while
// generate() throws, so both numbers must agree for the last attempt to settle instead of throwing.
export const NOTETAKER_SUMMARY_MAX_ATTEMPTS = 3;

export interface INotetakerSummaryServiceDeps {
  accessService: NotetakerAccessService;
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
  summaryRepository: INotetakerSummaryRepository;
  activityRepository: INotetakerActivityRepository;
  userRepository: INotetakerUserLookup;
  summaryGenerator: INotetakerSummaryGenerator;
  notetakerTasker: INotetakerTasker;
  config: NotetakerConfig;
  logger: ISimpleLogger;
}

export class NotetakerSummaryService {
  constructor(private readonly deps: INotetakerSummaryServiceDeps) {}

  async generate(payload: NotetakerGenerateSummaryPayload): Promise<void> {
    const { transcriptId, requestedByUserId } = payload;
    const { transcriptRepository, summaryRepository, config, logger } = this.deps;

    const transcript = await transcriptRepository.findById(transcriptId);
    if (!transcript) {
      logger.info("Notetaker summary skipped: transcript not found", { transcriptId });
      return;
    }

    const existing = await summaryRepository.findByTranscriptId(transcriptId);
    if (existing?.status === "READY" || existing?.status === "NOT_ENOUGH_CONTENT") return;

    // On every run, not only the first: a FAILED row from an earlier attempt goes back to PENDING
    // so the page shows "being generated" while the retry runs.
    await summaryRepository.upsertPending(transcriptId);
    const attempts = await summaryRepository.incrementAttempts(transcriptId);

    const passages = await transcriptRepository.findAllPassages(transcriptId);
    // Finalize decides this first with the same function; this is a guard for a direct enqueue.
    if (countTranscriptWords(passages) < config.limits.summaryMinWords) {
      await summaryRepository.setStatus(transcriptId, "NOT_ENOUGH_CONTENT", null);
      await this.notifyIfAutomatic(transcript, requestedByUserId);
      return;
    }

    const result = await this.runGenerator(transcript, passages);
    const failure = await this.saveIfValid(transcriptId, result);
    if (!failure) {
      await this.notifyIfAutomatic(transcript, requestedByUserId);
      return;
    }

    const { failureCode, retryable } = failure;
    await summaryRepository.setStatus(transcriptId, "FAILED", failureCode);

    const settled = !retryable || attempts >= NOTETAKER_SUMMARY_MAX_ATTEMPTS;
    logger.warn("Notetaker summary generation failed", { transcriptId, failureCode, attempts, settled });

    if (settled) {
      await this.notifyIfAutomatic(transcript, requestedByUserId);
      return;
    }

    // Throwing is what makes Trigger.dev retry; the row is already FAILED, so a crash before the
    // next attempt leaves a state the host can re-request from.
    throw ErrorWithCode.Factory.InternalServerError(
      `Notetaker summary generation for transcript ${transcriptId} failed with ${failureCode} (attempt ${attempts} of ${NOTETAKER_SUMMARY_MAX_ATTEMPTS})`
    );
  }

  async requestRegeneration(params: { bookingUid: string; userId: number }): Promise<NotetakerSummaryDto> {
    const { bookingUid, userId } = params;
    const {
      accessService,
      sessionRepository,
      summaryRepository,
      activityRepository,
      notetakerTasker,
      logger,
    } = this.deps;

    const booking = await accessService.assertHost({ bookingUid, userId });

    const latest = await sessionRepository.findLatestWithTranscriptByBookingId(booking.id);
    if (!latest) {
      throw ErrorWithCode.Factory.NotFound(`Booking ${bookingUid} has no notetaker transcript`);
    }
    if (latest.session.resultsDeletedAt !== null) {
      throw ErrorWithCode.Factory.NotFound(
        `Results of notetaker session ${latest.session.id} have been deleted`
      );
    }

    const transcriptId = latest.transcript.id;
    const existing = await summaryRepository.findByTranscriptId(transcriptId);
    if (existing && existing.status !== "FAILED") {
      throw ErrorWithCode.Factory.BadRequest(
        `Summary of booking ${bookingUid} is ${existing.status} and cannot be regenerated`
      );
    }

    const pending = await summaryRepository.upsertPending(transcriptId);

    const actorName = await this.findUserName(userId);
    await activityRepository.create({
      bookingId: booking.id,
      sessionId: latest.session.id,
      action: "SUMMARY_REQUESTED",
      actorType: "USER",
      actorUserId: userId,
      actorName,
      detail: null,
    });

    // No idempotency key: a transcript-scoped key would make Trigger.dev drop this request as a
    // duplicate of the automatic run.
    const result = await notetakerTasker.generateSummary({ transcriptId, requestedByUserId: userId });
    if (result.runId === "task-failed") {
      // PENDING refuses the next re-request and nothing else would move it. The re-read keeps the
      // failure code of a sync run that already failed inline.
      const current = await summaryRepository.findByTranscriptId(transcriptId);
      if (current?.status === "PENDING") {
        await summaryRepository.setStatus(transcriptId, "FAILED", "ENQUEUE_FAILED");
      }
      logger.error("Failed to enqueue the notetaker summary generation", {
        bookingId: booking.id,
        transcriptId,
      });
      throw ErrorWithCode.Factory.InternalServerError(
        `Could not queue the notetaker summary generation for booking ${bookingUid}`
      );
    }

    // The record from before the enqueue, not a re-read: the contract promises PENDING even when
    // the sync tasker already finished the generation inline.
    return toNotetakerSummaryDto(pending);
  }

  private async runGenerator(
    transcript: NotetakerTranscriptRecord,
    passages: NotetakerPassageRecord[]
  ): Promise<NotetakerSummaryResult> {
    try {
      return await this.deps.summaryGenerator.generate({ passages, languageHint: transcript.language });
    } catch (error) {
      // Only the name: the message or stack of a generator error can quote passage text.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      this.deps.logger.error("Notetaker summary generator threw", {
        transcriptId: transcript.id,
        errorName,
      });
      return { ok: false, failureCode: "UNEXPECTED_ERROR", retryable: true };
    }
  }

  private async saveIfValid(
    transcriptId: string,
    result: NotetakerSummaryResult
  ): Promise<NotetakerSummaryFailure | null> {
    if (!result.ok) return { failureCode: result.failureCode, retryable: result.retryable };

    const parsed = notetakerSummaryContentSchema.safeParse(result.content);
    // Final, not retryable: only a generator that skips its own validation can get here.
    if (!parsed.success) return { failureCode: "INVALID_OUTPUT", retryable: false };

    await this.deps.summaryRepository.saveResult(transcriptId, {
      status: "READY",
      language: parsed.data.language,
      overview: parsed.data.overview,
      keyPoints: parsed.data.keyPoints,
      decisions: parsed.data.decisions,
      actionItems: parsed.data.actionItems,
      model: result.model,
      generatedAt: new Date(),
    });
    return null;
  }

  private async notifyIfAutomatic(
    transcript: NotetakerTranscriptRecord,
    requestedByUserId: number | null
  ): Promise<void> {
    if (requestedByUserId !== null) return;

    const result = await this.deps.notetakerTasker.sendNotification(
      { kind: "RESULTS_READY", bookingId: transcript.bookingId, sessionId: transcript.sessionId },
      { idempotencyKey: `notetaker:RESULTS_READY:${transcript.sessionId}` }
    );
    if (result.runId === "task-failed") {
      this.deps.logger.error("Failed to enqueue the notetaker results notification", {
        sessionId: transcript.sessionId,
        bookingId: transcript.bookingId,
      });
    }
  }

  private async findUserName(userId: number): Promise<string | null> {
    const users = await this.deps.userRepository.findByIds({ ids: [userId] });
    return users.find((user) => user.id === userId)?.name ?? null;
  }
}
