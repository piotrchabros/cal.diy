import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";
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

export interface INotetakerResultsServiceDeps {
  accessService: NotetakerAccessService;
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
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
}
