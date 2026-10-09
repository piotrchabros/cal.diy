import type {
  NotetakerBotProviderDto,
  NotetakerOutcomeReasonDto,
  NotetakerPlatformDto,
  NotetakerSessionStatusDto,
} from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerBookingStatus } from "./IBookingNotetakerRepository";
import type { NotetakerTranscriptRecord } from "./INotetakerTranscriptRepository";

export type NotetakerSessionRecord = {
  id: string;
  bookingId: number;
  status: NotetakerSessionStatusDto;
  outcomeReason: NotetakerOutcomeReasonDto | null;
  platform: NotetakerPlatformDto;
  meetingUrl: string;
  botProvider: NotetakerBotProviderDto;
  externalRef: string | null;
  displayName: string;
  scheduledStartAt: Date;
  dispatchedAt: Date;
  joinRequestedAt: Date | null;
  admittedAt: Date | null;
  noticePostedAt: Date | null;
  endedAt: Date | null;
  startedLate: boolean;
  rejoinAttempted: boolean;
  interruptedAtMs: number | null;
  lastHeartbeatAt: Date | null;
  lastEventSequence: number;
  stopRequestedAt: Date | null;
  stopRequestedByUserId: number | null;
  resultsDeletedAt: Date | null;
  createdAt: Date;
};

export type NotetakerSessionCreateInput = Pick<
  NotetakerSessionRecord,
  "bookingId" | "platform" | "meetingUrl" | "botProvider" | "displayName" | "scheduledStartAt"
> &
  Partial<
    Pick<NotetakerSessionRecord, "status" | "outcomeReason" | "dispatchedAt" | "endedAt" | "startedLate">
  >;

export type NotetakerSessionUpdateInput = Partial<
  Omit<NotetakerSessionRecord, "id" | "bookingId" | "createdAt">
>;

export interface INotetakerSessionRepository {
  create(data: NotetakerSessionCreateInput): Promise<NotetakerSessionRecord>;
  findById(id: string): Promise<NotetakerSessionRecord | null>;
  /**
   * Ordered by dispatchedAt desc, then id desc.
   */
  findLatestByBookingId(bookingId: number): Promise<NotetakerSessionRecord | null>;
  findLatestWithTranscriptByBookingId(
    bookingId: number
  ): Promise<{ session: NotetakerSessionRecord; transcript: NotetakerTranscriptRecord } | null>;
  findByBookingIdAndStatusIn(
    bookingId: number,
    statuses: NotetakerSessionStatusDto[]
  ): Promise<NotetakerSessionRecord | null>;
  updateIfStatusIn(
    id: string,
    fromStatuses: NotetakerSessionStatusDto[],
    data: NotetakerSessionUpdateInput
  ): Promise<boolean>;
  update(id: string, data: NotetakerSessionUpdateInput): Promise<void>;
  deleteById(id: string): Promise<boolean>;
  /**
   * Ordered by booking.startTime asc.
   */
  findByStatusInIncludeBooking(params: {
    statuses: NotetakerSessionStatusDto[];
    limit: number;
  }): Promise<(NotetakerSessionRecord & { bookingStatus: NotetakerBookingStatus })[]>;
  setResultsDeletedAtByIds(ids: string[], at: Date): Promise<number>;
}
