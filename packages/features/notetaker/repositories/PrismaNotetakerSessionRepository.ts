import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { NotetakerBookingStatus } from "./interfaces/IBookingNotetakerRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionCreateInput,
  NotetakerSessionRecord,
  NotetakerSessionUpdateInput,
} from "./interfaces/INotetakerSessionRepository";
import type { NotetakerTranscriptRecord } from "./interfaces/INotetakerTranscriptRepository";

const sessionSelect = {
  id: true,
  bookingId: true,
  status: true,
  outcomeReason: true,
  platform: true,
  meetingUrl: true,
  botProvider: true,
  externalRef: true,
  displayName: true,
  scheduledStartAt: true,
  dispatchedAt: true,
  joinRequestedAt: true,
  admittedAt: true,
  noticePostedAt: true,
  endedAt: true,
  startedLate: true,
  rejoinAttempted: true,
  interruptedAtMs: true,
  lastHeartbeatAt: true,
  lastEventSequence: true,
  stopRequestedAt: true,
  stopRequestedByUserId: true,
  resultsDeletedAt: true,
  colleagueSharingDisclosed: true,
  createdAt: true,
} satisfies Prisma.NotetakerSessionSelect;

const transcriptSelect = {
  id: true,
  sessionId: true,
  bookingId: true,
  language: true,
  completeness: true,
  durationMs: true,
  passageCount: true,
  speakerNamesAvailable: true,
  createdAt: true,
} satisfies Prisma.NotetakerTranscriptSelect;

const latestOrder = [
  { dispatchedAt: "desc" },
  { id: "desc" },
] satisfies Prisma.NotetakerSessionOrderByWithRelationInput[];

export class PrismaNotetakerSessionRepository implements INotetakerSessionRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async create(data: NotetakerSessionCreateInput): Promise<NotetakerSessionRecord> {
    return await this.prismaClient.notetakerSession.create({
      data: {
        bookingId: data.bookingId,
        platform: data.platform,
        meetingUrl: data.meetingUrl,
        botProvider: data.botProvider,
        displayName: data.displayName,
        scheduledStartAt: data.scheduledStartAt,
        status: data.status,
        outcomeReason: data.outcomeReason,
        dispatchedAt: data.dispatchedAt,
        endedAt: data.endedAt,
        startedLate: data.startedLate,
        colleagueSharingDisclosed: data.colleagueSharingDisclosed,
      },
      select: sessionSelect,
    });
  }

  async findById(id: string): Promise<NotetakerSessionRecord | null> {
    return await this.prismaClient.notetakerSession.findUnique({
      where: { id },
      select: sessionSelect,
    });
  }

  async findLatestByBookingId(bookingId: number): Promise<NotetakerSessionRecord | null> {
    return await this.prismaClient.notetakerSession.findFirst({
      where: { bookingId },
      orderBy: latestOrder,
      select: sessionSelect,
    });
  }

  async findEarliestByBookingId(bookingId: number): Promise<NotetakerSessionRecord | null> {
    return await this.prismaClient.notetakerSession.findFirst({
      where: { bookingId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: sessionSelect,
    });
  }

  async findLatestWithTranscriptByBookingId(
    bookingId: number
  ): Promise<{ session: NotetakerSessionRecord; transcript: NotetakerTranscriptRecord } | null> {
    const row = await this.prismaClient.notetakerSession.findFirst({
      where: { bookingId, transcript: { isNot: null } },
      orderBy: latestOrder,
      select: { ...sessionSelect, transcript: { select: transcriptSelect } },
    });
    if (!row || !row.transcript) return null;
    const { transcript, ...session } = row;
    return { session, transcript };
  }

  async findByBookingIdAndStatusIn(
    bookingId: number,
    statuses: NotetakerSessionStatusDto[]
  ): Promise<NotetakerSessionRecord | null> {
    return await this.prismaClient.notetakerSession.findFirst({
      where: { bookingId, status: { in: statuses } },
      orderBy: latestOrder,
      select: sessionSelect,
    });
  }

  async updateIfStatusIn(
    id: string,
    fromStatuses: NotetakerSessionStatusDto[],
    data: NotetakerSessionUpdateInput
  ): Promise<boolean> {
    // Single conditional statement so concurrent transitions race on the row, not on a read-then-write gap.
    const { count } = await this.prismaClient.notetakerSession.updateMany({
      where: { id, status: { in: fromStatuses } },
      data,
    });
    return count === 1;
  }

  async update(id: string, data: NotetakerSessionUpdateInput): Promise<void> {
    // updateMany so a session deleted while a bot event is in flight is a no-op instead of a P2025 throw.
    await this.prismaClient.notetakerSession.updateMany({
      where: { id },
      data,
    });
  }

  async deleteById(id: string): Promise<boolean> {
    const { count } = await this.prismaClient.notetakerSession.deleteMany({ where: { id } });
    return count > 0;
  }

  async findByStatusInIncludeBooking(params: {
    statuses: NotetakerSessionStatusDto[];
    limit: number;
  }): Promise<(NotetakerSessionRecord & { bookingStatus: NotetakerBookingStatus })[]> {
    const rows = await this.prismaClient.notetakerSession.findMany({
      where: { status: { in: params.statuses } },
      orderBy: [{ booking: { startTime: "asc" } }, { id: "asc" }],
      take: params.limit,
      select: { ...sessionSelect, booking: { select: { status: true } } },
    });
    return rows.map(({ booking, ...session }) => ({ ...session, bookingStatus: booking.status }));
  }

  async setResultsDeletedAtByIds(ids: string[], at: Date): Promise<number> {
    const { count } = await this.prismaClient.notetakerSession.updateMany({
      where: { id: { in: ids } },
      data: { resultsDeletedAt: at },
    });
    return count;
  }
}
