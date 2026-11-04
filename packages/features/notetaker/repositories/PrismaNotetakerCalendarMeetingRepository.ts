import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import type {
  INotetakerCalendarMeetingRepository,
  NotetakerCalDiyBookingMatchRecord,
  NotetakerCalendarMeetingRecord,
} from "./interfaces/INotetakerCalendarMeetingRepository";

const meetingSelect = {
  id: true,
  bookingId: true,
  ownerUserId: true,
  meetingKey: true,
  startTime: true,
  endTime: true,
  booking: { select: { uid: true, notetakerSessions: { take: 1, select: { id: true } } } },
  participants: {
    select: { userId: true, selectedCalendarId: true, externalEventId: true, removedAt: true },
    orderBy: { userId: "asc" },
  },
} satisfies Prisma.NotetakerCalendarMeetingSelect;

type MeetingRow = Prisma.NotetakerCalendarMeetingGetPayload<{ select: typeof meetingSelect }>;

function toRecord({ booking, ...row }: MeetingRow): NotetakerCalendarMeetingRecord {
  return { ...row, bookingUid: booking.uid, hasSession: booking.notetakerSessions.length > 0 };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export class PrismaNotetakerCalendarMeetingRepository implements INotetakerCalendarMeetingRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByParticipantEvent(params: {
    selectedCalendarId: string;
    externalEventId: string;
  }): Promise<NotetakerCalendarMeetingRecord | null> {
    const row = await this.prismaClient.notetakerCalendarMeeting.findFirst({
      where: {
        participants: {
          some: { selectedCalendarId: params.selectedCalendarId, externalEventId: params.externalEventId },
        },
      },
      orderBy: { startTime: "desc" },
      select: meetingSelect,
    });
    return row ? toRecord(row) : null;
  }

  async findByKey(params: {
    meetingKey: string;
    startTime: Date;
  }): Promise<NotetakerCalendarMeetingRecord | null> {
    const row = await this.prismaClient.notetakerCalendarMeeting.findUnique({
      where: { meetingKey_startTime: { meetingKey: params.meetingKey, startTime: params.startTime } },
      select: meetingSelect,
    });
    return row ? toRecord(row) : null;
  }

  async findActiveByCalendarInRange(params: {
    selectedCalendarId: string;
    from: Date;
    to: Date;
  }): Promise<NotetakerCalendarMeetingRecord[]> {
    const rows = await this.prismaClient.notetakerCalendarMeeting.findMany({
      where: {
        startTime: { gte: params.from, lt: params.to },
        participants: { some: { selectedCalendarId: params.selectedCalendarId, removedAt: null } },
      },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
      select: meetingSelect,
    });
    return rows.map(toRecord);
  }

  async createWithBooking(
    params: Parameters<INotetakerCalendarMeetingRepository["createWithBooking"]>[0]
  ): Promise<NotetakerCalendarMeetingRecord | "CONFLICT"> {
    const { owner } = params;
    try {
      const row = await this.prismaClient.$transaction(async (tx) => {
        const booking = await tx.booking.create({
          data: {
            uid: params.bookingUid,
            userId: owner.userId,
            title: params.title,
            startTime: params.startTime,
            endTime: params.endTime,
            location: params.meetingUrl,
            iCalUID: params.iCalUID,
            metadata: params.metadata,
            status: "ACCEPTED",
            notetaker: {
              create: {
                enabled: true,
                pendingDispatch: true,
                source: "CALENDAR_AUTO_JOIN",
                setByUserId: null,
              },
            },
          },
          select: { id: true },
        });
        await tx.notetakerActivity.create({
          data: {
            bookingId: booking.id,
            action: "ENABLED",
            actorType: "SYSTEM",
            actorUserId: null,
            actorName: null,
            detail: { source: "CALENDAR_AUTO_JOIN" },
          },
          select: { id: true },
        });
        return await tx.notetakerCalendarMeeting.create({
          data: {
            bookingId: booking.id,
            meetingKey: params.meetingKey,
            startTime: params.startTime,
            endTime: params.endTime,
            iCalUID: params.iCalUID,
            ownerUserId: owner.userId,
            participants: {
              create: {
                userId: owner.userId,
                selectedCalendarId: owner.selectedCalendarId,
                externalEventId: owner.externalEventId,
                lastSeenAt: params.seenAt,
              },
            },
          },
          select: meetingSelect,
        });
      });
      return toRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) return "CONFLICT";
      throw error;
    }
  }

  async upsertParticipant(
    params: Parameters<INotetakerCalendarMeetingRepository["upsertParticipant"]>[0]
  ): Promise<void> {
    const { meetingId, bookingId, userId, email } = params;
    await this.prismaClient.$transaction(async (tx) => {
      await tx.notetakerCalendarMeetingParticipant.upsert({
        where: { meetingId_userId: { meetingId, userId } },
        create: {
          meetingId,
          userId,
          selectedCalendarId: params.selectedCalendarId,
          externalEventId: params.externalEventId,
          lastSeenAt: params.seenAt,
        },
        update: {
          selectedCalendarId: params.selectedCalendarId,
          externalEventId: params.externalEventId,
          lastSeenAt: params.seenAt,
          removedAt: null,
        },
        select: { userId: true },
      });

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { userId: true },
      });
      if (!booking || booking.userId === userId) return;

      const existing = await tx.attendee.findFirst({
        where: { bookingId, email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) return;
      await tx.attendee.create({
        data: { bookingId, email, name: params.name, timeZone: params.timeZone },
        select: { id: true },
      });
    });
  }

  async markParticipantRemoved(params: { meetingId: string; userId: number; at: Date }): Promise<void> {
    await this.prismaClient.notetakerCalendarMeetingParticipant.updateMany({
      where: { meetingId: params.meetingId, userId: params.userId, removedAt: null },
      data: { removedAt: params.at },
    });
  }

  async touchParticipant(params: { meetingId: string; userId: number; seenAt: Date }): Promise<void> {
    await this.prismaClient.notetakerCalendarMeetingParticipant.updateMany({
      where: { meetingId: params.meetingId, userId: params.userId },
      data: { lastSeenAt: params.seenAt },
    });
  }

  async reschedule(params: {
    meetingId: string;
    bookingId: number;
    startTime: Date;
    endTime: Date;
    meetingUrl: string;
    meetingKey: string;
  }): Promise<"OK" | "CONFLICT"> {
    try {
      await this.prismaClient.$transaction(async (tx) => {
        await tx.notetakerCalendarMeeting.update({
          where: { id: params.meetingId },
          data: { startTime: params.startTime, endTime: params.endTime, meetingKey: params.meetingKey },
          select: { id: true },
        });
        await tx.booking.update({
          where: { id: params.bookingId },
          data: { startTime: params.startTime, endTime: params.endTime, location: params.meetingUrl },
          select: { id: true },
        });
      });
      return "OK";
    } catch (error) {
      if (isUniqueViolation(error)) return "CONFLICT";
      throw error;
    }
  }

  async transferOwner(params: { meetingId: string; bookingId: number; userId: number }): Promise<void> {
    await this.prismaClient.$transaction(async (tx) => {
      await tx.notetakerCalendarMeeting.update({
        where: { id: params.meetingId },
        data: { ownerUserId: params.userId },
        select: { id: true },
      });
      await tx.booking.update({
        where: { id: params.bookingId },
        data: { userId: params.userId },
        select: { id: true },
      });
    });
  }

  async cancel(params: { meetingId: string; bookingId: number }): Promise<void> {
    await this.prismaClient.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: params.bookingId },
        data: { status: "CANCELLED" },
        select: { id: true },
      });
      await tx.bookingNotetaker.updateMany({
        where: { bookingId: params.bookingId, enabled: true },
        data: { enabled: false, pendingDispatch: false },
      });
    });
  }

  async isParticipant(params: { bookingId: number; userId: number }): Promise<boolean> {
    const count = await this.prismaClient.notetakerCalendarMeetingParticipant.count({
      where: { userId: params.userId, removedAt: null, meeting: { bookingId: params.bookingId } },
    });
    return count > 0;
  }

  async countCreatedByOwnerSince(params: { userId: number; since: Date }): Promise<number> {
    return await this.prismaClient.notetakerCalendarMeeting.count({
      where: { ownerUserId: params.userId, createdAt: { gte: params.since } },
    });
  }

  async findCalDiyBookingForEvent(params: {
    iCalUID: string | null;
    externalEventId: string;
  }): Promise<NotetakerCalDiyBookingMatchRecord | null> {
    const matchers: Prisma.BookingWhereInput[] = [
      {
        references: {
          some: {
            uid: params.externalEventId,
            OR: [{ deleted: null }, { deleted: false }],
          },
        },
      },
    ];
    // Bookings default iCalUID to "", so an empty value must never match.
    if (params.iCalUID) matchers.push({ iCalUID: params.iCalUID });

    const row = await this.prismaClient.booking.findFirst({
      where: {
        status: { notIn: ["CANCELLED", "REJECTED"] },
        notetakerCalendarMeeting: null,
        OR: matchers,
      },
      orderBy: { id: "asc" },
      select: { id: true, userId: true, notetaker: { select: { bookingId: true } } },
    });
    if (!row) return null;
    return { bookingId: row.id, hostUserId: row.userId, hasNotetakerChoice: row.notetaker !== null };
  }

  async enableChoiceForCalendarAutoJoin(params: { bookingId: number }): Promise<boolean> {
    return await this.prismaClient.$transaction(async (tx) => {
      const { count } = await tx.bookingNotetaker.createMany({
        data: [
          {
            bookingId: params.bookingId,
            enabled: true,
            pendingDispatch: true,
            source: "CALENDAR_AUTO_JOIN",
            setByUserId: null,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await tx.notetakerActivity.create({
        data: {
          bookingId: params.bookingId,
          action: "ENABLED",
          actorType: "SYSTEM",
          actorUserId: null,
          actorName: null,
          detail: { source: "CALENDAR_AUTO_JOIN" },
        },
        select: { id: true },
      });
      return true;
    });
  }
}
