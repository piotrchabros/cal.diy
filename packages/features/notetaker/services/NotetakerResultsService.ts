import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getTranslation } from "@calcom/i18n/server";
import type { NotetakerActivityDto } from "@calcom/lib/dto/NotetakerActivityDto";
import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerExportDto, NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerExportLabels } from "../lib/exportMarkdown";
import { exportMarkdown } from "../lib/exportMarkdown";
import { NOTETAKER_LIVE_SESSION_STATUSES } from "../lib/sessionStateMachine";
import { toNotetakerSummaryDto } from "../lib/summaryDto";
import type { INotetakerTasker } from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";
import type { INotetakerSummaryRepository } from "../repositories/interfaces/INotetakerSummaryRepository";
import type {
  INotetakerTranscriptRepository,
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import type { NotetakerAccessService } from "./NotetakerAccessService";

const DEFAULT_PASSAGE_LIMIT = 200;
const MIN_PASSAGE_LIMIT = 1;
const MAX_PASSAGE_LIMIT = 500;

// Mapped field by field so the internal speakerKey can never reach a client.
function toPassageDto(passage: NotetakerPassageRecord): NotetakerPassageDto {
  return {
    index: passage.index,
    speakerName: passage.speakerName,
    unknownSpeakerNumber: passage.unknownSpeakerNumber,
    startMs: passage.startMs,
    endMs: passage.endMs,
    text: passage.text,
    language: passage.language,
  };
}

export const NOTETAKER_ACTIVITY_LIMIT = 200;

export interface INotetakerResultsServiceDeps {
  accessService: NotetakerAccessService;
  bookingNotetakerRepository: IBookingNotetakerRepository;
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
  summaryRepository: INotetakerSummaryRepository;
  activityRepository: INotetakerActivityRepository;
  userRepository: INotetakerUserLookup;
  notetakerTasker: INotetakerTasker;
  logger: ISimpleLogger;
}

export class NotetakerResultsService {
  constructor(private readonly deps: INotetakerResultsServiceDeps) {}

  async listPassages(params: {
    bookingUid: string;
    sessionId?: string;
    cursor?: number | null;
    limit?: number;
    userId: number;
  }): Promise<{ passages: NotetakerPassageDto[]; nextCursor: number | null }> {
    const { bookingUid, sessionId, userId } = params;

    const { booking } = await this.deps.accessService.resolveViewerRole({ bookingUid, userId });
    const transcript = await this.resolveTranscript({ bookingId: booking.id, bookingUid, sessionId });

    const limit = Math.min(
      Math.max(params.limit ?? DEFAULT_PASSAGE_LIMIT, MIN_PASSAGE_LIMIT),
      MAX_PASSAGE_LIMIT
    );

    // One extra row tells whether another page exists without a count query.
    const rows = await this.deps.transcriptRepository.findPassagesPage({
      transcriptId: transcript.id,
      cursor: params.cursor ?? null,
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    let nextCursor: number | null = null;
    if (hasMore) nextCursor = page[page.length - 1].index;

    return { passages: page.map(toPassageDto), nextCursor };
  }

  private async resolveTranscript(params: {
    bookingId: number;
    bookingUid: string;
    sessionId?: string;
  }): Promise<NotetakerTranscriptRecord> {
    const { bookingId, bookingUid, sessionId } = params;

    if (sessionId) {
      const session = await this.deps.sessionRepository.findById(sessionId);
      if (!session || session.bookingId !== bookingId) {
        throw ErrorWithCode.Factory.NotFound(
          `Notetaker session ${sessionId} not found for booking ${bookingUid}`
        );
      }
      if (session.resultsDeletedAt !== null) {
        throw ErrorWithCode.Factory.NotFound(`Results of notetaker session ${sessionId} have been deleted`);
      }

      const transcript = await this.deps.transcriptRepository.findBySessionId(session.id);
      if (!transcript) {
        throw ErrorWithCode.Factory.NotFound(`Notetaker session ${sessionId} has no transcript`);
      }
      return transcript;
    }

    const latest = await this.deps.sessionRepository.findLatestWithTranscriptByBookingId(bookingId);
    if (!latest) {
      throw ErrorWithCode.Factory.NotFound(`Booking ${bookingUid} has no notetaker transcript`);
    }
    if (latest.session.resultsDeletedAt !== null) {
      throw ErrorWithCode.Factory.NotFound(
        `Results of notetaker session ${latest.session.id} have been deleted`
      );
    }
    return latest.transcript;
  }

  async setSharing(params: {
    bookingUid: string;
    shared: boolean;
    userId: number;
  }): Promise<{ sharedWithAttendees: boolean }> {
    const { bookingUid, shared, userId } = params;

    const booking = await this.deps.accessService.assertHost({ bookingUid, userId });

    if (!shared) {
      // Only a deleted row is recorded, so the history shows one entry per real revocation.
      const removed = await this.deps.bookingNotetakerRepository.deleteSharingGrant(booking.id);
      if (removed) {
        const actor = await this.findActor(userId);
        await this.createUserActivity({
          bookingId: booking.id,
          sessionId: null,
          action: "SHARING_REVOKED",
          userId,
          actorName: actor?.name ?? null,
        });
      }
      return { sharedWithAttendees: false };
    }

    const latest = await this.deps.sessionRepository.findLatestWithTranscriptByBookingId(booking.id);
    if (!latest || latest.session.resultsDeletedAt !== null) {
      throw ErrorWithCode.Factory.BadRequest(`Booking ${bookingUid} has no notetaker transcript to share`);
    }

    // The insert is the swap: the grant is not read first, so of two concurrent calls
    // exactly one records the activity and notifies the attendees.
    const created = await this.deps.bookingNotetakerRepository.createSharingGrantIfMissing({
      bookingId: booking.id,
      grantedByUserId: userId,
    });
    if (!created) return { sharedWithAttendees: true };

    const actor = await this.findActor(userId);
    await this.createUserActivity({
      bookingId: booking.id,
      sessionId: null,
      action: "SHARED",
      userId,
      actorName: actor?.name ?? null,
    });

    const result = await this.deps.notetakerTasker.sendNotification({
      kind: "SHARED_WITH_ATTENDEES",
      bookingId: booking.id,
      sessionId: null,
    });
    if (result.runId === "task-failed") {
      // The grant and the activity stand; only the attendees' email is lost.
      this.deps.logger.error("Failed to enqueue the notetaker shared notice", { bookingId: booking.id });
    }
    return { sharedWithAttendees: true };
  }

  async deleteResults(params: { bookingUid: string; userId: number }): Promise<void> {
    const { bookingUid, userId } = params;

    const booking = await this.deps.accessService.assertHost({ bookingUid, userId });

    const transcripts = await this.deps.transcriptRepository.findIdsByBookingId(booking.id);
    if (transcripts.length === 0) {
      throw ErrorWithCode.Factory.NotFound(`Booking ${bookingUid} has no notetaker results to delete`);
    }

    // A live session would recreate the transcript on its next passages event,
    // leaving text stored behind a "deleted" marker.
    const live = await this.deps.sessionRepository.findByBookingIdAndStatusIn(
      booking.id,
      NOTETAKER_LIVE_SESSION_STATUSES
    );
    if (live) {
      throw ErrorWithCode.Factory.BadRequest(
        `Notetaker results of booking ${bookingUid} cannot be deleted while a session is in progress`
      );
    }

    const latestSession = await this.deps.sessionRepository.findLatestByBookingId(booking.id);

    // The delete is the swap and runs first: once it returns the text is gone whatever happens next,
    // and only the call that removed rows stamps the sessions and records the deletion.
    const deletedCount = await this.deps.transcriptRepository.deleteByBookingId(booking.id);
    if (deletedCount === 0) {
      throw ErrorWithCode.Factory.NotFound(`Booking ${bookingUid} has no notetaker results to delete`);
    }

    const now = new Date();
    const sessionIds = transcripts.map((transcript) => transcript.sessionId);
    // The state query returns the latest session, which may be a later one that never had a transcript.
    if (latestSession) sessionIds.push(latestSession.id);
    await this.deps.sessionRepository.setResultsDeletedAtByIds(Array.from(new Set(sessionIds)), now);

    await this.deps.bookingNotetakerRepository.deleteSharingGrant(booking.id);

    const actor = await this.findActor(userId);
    await this.createUserActivity({
      bookingId: booking.id,
      sessionId: null,
      action: "DELETED",
      userId,
      actorName: actor?.name ?? null,
    });
  }

  async export(params: {
    bookingUid: string;
    format: "markdown";
    userId: number;
  }): Promise<NotetakerExportDto> {
    const { bookingUid, userId } = params;

    const { booking } = await this.deps.accessService.resolveViewerRole({ bookingUid, userId });

    const latest = await this.deps.sessionRepository.findLatestWithTranscriptByBookingId(booking.id);
    if (!latest) {
      throw ErrorWithCode.Factory.NotFound(`Booking ${bookingUid} has no notetaker transcript`);
    }
    if (latest.session.resultsDeletedAt !== null) {
      throw ErrorWithCode.Factory.NotFound(
        `Results of notetaker session ${latest.session.id} have been deleted`
      );
    }

    const passageRecords = await this.deps.transcriptRepository.findAllPassages(latest.transcript.id);
    const summaryRecord = await this.deps.summaryRepository.findByTranscriptId(latest.transcript.id);
    let summary: NotetakerSummaryDto | null = null;
    if (summaryRecord) summary = toNotetakerSummaryDto(summaryRecord);

    const actor = await this.findActor(userId);
    const locale = actor?.locale ?? "en";
    const timeZone = actor?.timeZone ?? "UTC";
    const t = await getTranslation(locale, "common");

    const reasonKey = `notetaker_reason_${(latest.session.outcomeReason ?? "INTERRUPTED").toLowerCase()}`;
    // Values are interpolated unescaped because the target is Markdown, which exportMarkdown escapes itself.
    const labels: NotetakerExportLabels = {
      summaryHeading: t("notetaker_export_summary_heading"),
      overviewHeading: t("notetaker_summary_overview"),
      keyPointsHeading: t("notetaker_summary_key_points"),
      decisionsHeading: t("notetaker_summary_decisions"),
      actionItemsHeading: t("notetaker_summary_action_items"),
      transcriptHeading: t("notetaker_export_transcript_heading"),
      noSummary: t("notetaker_export_no_summary"),
      partialNote: t("notetaker_transcript_incomplete", {
        reason: t(reasonKey),
        interpolation: { escapeValue: false },
      }),
      truncatedNote: t("notetaker_transcript_truncated"),
      speakerNamesUnavailableNote: t("notetaker_speaker_names_unavailable"),
      owner: (name: string): string =>
        t("notetaker_summary_owner", { name, interpolation: { escapeValue: false } }),
      unknownSpeaker: (number: number): string => t("notetaker_unknown_speaker", { number }),
    };

    const { filename, content } = exportMarkdown({
      bookingTitle: booking.title,
      bookingStartTime: booking.startTime,
      locale,
      timeZone,
      summary,
      transcript: {
        completeness: latest.transcript.completeness,
        speakerNamesAvailable: latest.transcript.speakerNamesAvailable,
      },
      passages: passageRecords.map(toPassageDto),
      labels,
    });

    // Awaited before returning: an export that cannot be recorded is not handed out.
    await this.createUserActivity({
      bookingId: booking.id,
      sessionId: latest.session.id,
      action: "EXPORTED",
      userId,
      actorName: actor?.name ?? null,
    });

    return { filename, mimeType: "text/markdown", content };
  }

  async getActivity(params: { bookingUid: string; userId: number }): Promise<NotetakerActivityDto[]> {
    const { bookingUid, userId } = params;

    const booking = await this.deps.accessService.assertHost({ bookingUid, userId });

    const rows = await this.deps.activityRepository.findByBookingId({
      bookingId: booking.id,
      limit: NOTETAKER_ACTIVITY_LIMIT,
    });

    // Mapped field by field so bookingId, sessionId and actorUserId never reach a client.
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType,
      actorName: row.actorName,
      createdAt: row.createdAt.toISOString(),
      detail: row.detail,
    }));
  }

  private async findActor(userId: number): Promise<NotetakerUserRecord | null> {
    const users = await this.deps.userRepository.findByIds({ ids: [userId] });
    for (let i = 0; i < users.length; i++) {
      if (users[i].id !== userId) continue;
      // Copied field by field: the lookup may be backed by a query that returns secret columns.
      return {
        id: users[i].id,
        name: users[i].name,
        email: users[i].email,
        locale: users[i].locale,
        timeZone: users[i].timeZone,
      };
    }
    return null;
  }

  private async createUserActivity(params: {
    bookingId: number;
    sessionId: string | null;
    action: "SHARED" | "SHARING_REVOKED" | "EXPORTED" | "DELETED";
    userId: number;
    actorName: string | null;
  }): Promise<void> {
    const { bookingId, sessionId, action, userId, actorName } = params;

    await this.deps.activityRepository.create({
      bookingId,
      sessionId,
      action,
      actorType: "USER",
      actorUserId: userId,
      actorName,
      detail: null,
    });
  }
}
