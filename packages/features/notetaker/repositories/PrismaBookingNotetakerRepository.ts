import type { NotetakerChoiceSourceDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type {
  BookingNotetakerRecord,
  IBookingNotetakerRepository,
  NotetakerBookingContext,
  NotetakerBookingStatus,
  NotetakerSharingGrantRecord,
} from "./interfaces/IBookingNotetakerRepository";

const choiceSelect = {
  bookingId: true,
  enabled: true,
  pendingDispatch: true,
  source: true,
  appliedToSeries: true,
  rejoinBlocked: true,
  setByUserId: true,
  setAt: true,
  attendeesNotifiedAt: true,
  notifiedAttendeeEmails: true,
} satisfies Prisma.BookingNotetakerSelect;

const sharingGrantSelect = {
  bookingId: true,
  grantedByUserId: true,
  grantedAt: true,
} satisfies Prisma.NotetakerSharingGrantSelect;

const bookingBaseSelect = {
  id: true,
  uid: true,
  userId: true,
  status: true,
  startTime: true,
  endTime: true,
  title: true,
  location: true,
  metadata: true,
  recurringEventId: true,
  eventTypeId: true,
  attendees: { select: { email: true } },
  references: {
    // deleted is nullable and `{ not: true }` would drop NULL rows in SQL
    where: { OR: [{ deleted: null }, { deleted: false }] },
    select: { type: true, meetingUrl: true },
  },
  eventType: {
    select: {
      hosts: { select: { userId: true, user: { select: { email: true } } } },
      users: { select: { id: true, email: true } },
    },
  },
  user: { select: { id: true, name: true, email: true, locale: true } },
} satisfies Prisma.BookingSelect;

const bookingContextSelect = {
  ...bookingBaseSelect,
  notetaker: { select: choiceSelect },
} satisfies Prisma.BookingSelect;

function toBookingContext(
  booking: Prisma.BookingGetPayload<{ select: typeof bookingBaseSelect }>,
  choice: BookingNotetakerRecord | null
): NotetakerBookingContext {
  const hostsByUserId = new Map<number, { userId: number; email: string }>();
  for (const host of booking.eventType?.hosts ?? []) {
    hostsByUserId.set(host.userId, { userId: host.userId, email: host.user.email });
  }
  for (const user of booking.eventType?.users ?? []) {
    if (!hostsByUserId.has(user.id)) {
      hostsByUserId.set(user.id, { userId: user.id, email: user.email });
    }
  }

  return {
    id: booking.id,
    uid: booking.uid,
    userId: booking.userId,
    status: booking.status,
    startTime: booking.startTime,
    endTime: booking.endTime,
    title: booking.title,
    location: booking.location,
    metadata: booking.metadata,
    recurringEventId: booking.recurringEventId,
    eventTypeId: booking.eventTypeId,
    attendeeEmails: booking.attendees.map((attendee) => attendee.email),
    references: booking.references,
    eventTypeHosts: Array.from(hostsByUserId.values()),
    organizer: booking.user,
    choice,
  };
}

export class PrismaBookingNotetakerRepository implements IBookingNotetakerRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findByBookingId(bookingId: number): Promise<BookingNotetakerRecord | null> {
    return await this.prismaClient.bookingNotetaker.findUnique({
      where: { bookingId },
      select: choiceSelect,
    });
  }

  async findByBookingUidIncludeBooking(bookingUid: string): Promise<NotetakerBookingContext | null> {
    const row = await this.prismaClient.booking.findUnique({
      where: { uid: bookingUid },
      select: bookingContextSelect,
    });
    if (!row) return null;
    return toBookingContext(row, row.notetaker);
  }

  async findByBookingIdIncludeBooking(bookingId: number): Promise<NotetakerBookingContext | null> {
    const row = await this.prismaClient.booking.findUnique({
      where: { id: bookingId },
      select: bookingContextSelect,
    });
    if (!row) return null;
    return toBookingContext(row, row.notetaker);
  }

  async upsert(data: {
    bookingId: number;
    enabled: boolean;
    pendingDispatch: boolean;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByUserId: number | null;
    setAt: Date;
    notifiedAttendeeEmails?: string[];
  }): Promise<BookingNotetakerRecord> {
    return await this.prismaClient.bookingNotetaker.upsert({
      where: { bookingId: data.bookingId },
      create: {
        bookingId: data.bookingId,
        enabled: data.enabled,
        pendingDispatch: data.pendingDispatch,
        source: data.source,
        appliedToSeries: data.appliedToSeries,
        setByUserId: data.setByUserId,
        setAt: data.setAt,
        notifiedAttendeeEmails: data.notifiedAttendeeEmails,
      },
      update: {
        enabled: data.enabled,
        pendingDispatch: data.pendingDispatch,
        source: data.source,
        appliedToSeries: data.appliedToSeries,
        setByUserId: data.setByUserId,
        setAt: data.setAt,
        notifiedAttendeeEmails: data.notifiedAttendeeEmails,
      },
      select: choiceSelect,
    });
  }

  async disable(bookingId: number): Promise<void> {
    await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId },
      data: { enabled: false, pendingDispatch: false },
    });
  }

  async clearPendingDispatch(bookingId: number): Promise<boolean> {
    // A single conditional UPDATE is what guarantees only one caller wins the dispatch
    // (one session per booking); a read-then-write would let two workers both proceed.
    const { count } = await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId, pendingDispatch: true },
      data: { pendingDispatch: false },
    });
    return count === 1;
  }

  async setPendingDispatch(bookingId: number, pendingDispatch: boolean): Promise<void> {
    await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId },
      data: { pendingDispatch },
    });
  }

  async setRejoinBlocked(bookingId: number, rejoinBlocked: boolean): Promise<void> {
    await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId },
      data: { rejoinBlocked },
    });
  }

  async findEnabledIncludeBooking(params: {
    bookingStatuses: NotetakerBookingStatus[];
    startTimeLte: Date;
    endTimeGt?: Date;
    pendingDispatch?: boolean;
    limit: number;
  }): Promise<NotetakerBookingContext[]> {
    const rows = await this.prismaClient.bookingNotetaker.findMany({
      where: {
        enabled: true,
        pendingDispatch: params.pendingDispatch,
        booking: {
          status: { in: params.bookingStatuses },
          startTime: { lte: params.startTimeLte },
          endTime: params.endTimeGt ? { gt: params.endTimeGt } : undefined,
        },
      },
      orderBy: [{ booking: { startTime: "asc" } }, { bookingId: "asc" }],
      take: params.limit,
      select: { ...choiceSelect, booking: { select: bookingBaseSelect } },
    });
    return rows.map(({ booking, ...choice }) => toBookingContext(booking, choice));
  }

  async findByRecurringEventIdFromStartTime(params: {
    recurringEventId: string;
    startTimeGte: Date;
  }): Promise<
    { bookingId: number; bookingUid: string; startTime: Date; choice: BookingNotetakerRecord | null }[]
  > {
    const rows = await this.prismaClient.booking.findMany({
      where: {
        recurringEventId: params.recurringEventId,
        startTime: { gte: params.startTimeGte },
      },
      select: { id: true, uid: true, startTime: true, notetaker: { select: choiceSelect } },
      orderBy: { startTime: "asc" },
    });
    return rows.map((row) => ({
      bookingId: row.id,
      bookingUid: row.uid,
      startTime: row.startTime,
      choice: row.notetaker,
    }));
  }

  async appendNotifiedAttendeeEmails(bookingId: number, emails: string[], at: Date): Promise<void> {
    await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId },
      data: { notifiedAttendeeEmails: { push: emails }, attendeesNotifiedAt: at },
    });
  }

  async findNotifiedAttendeeEmailsByRecurringEventId(recurringEventId: string): Promise<string[]> {
    const rows = await this.prismaClient.bookingNotetaker.findMany({
      where: { booking: { recurringEventId } },
      select: { notifiedAttendeeEmails: true },
    });
    return Array.from(new Set(rows.flatMap((row) => row.notifiedAttendeeEmails)));
  }

  async findSharingGrant(bookingId: number): Promise<NotetakerSharingGrantRecord | null> {
    return await this.prismaClient.notetakerSharingGrant.findUnique({
      where: { bookingId },
      select: sharingGrantSelect,
    });
  }

  async createSharingGrant(data: {
    bookingId: number;
    grantedByUserId: number | null;
  }): Promise<NotetakerSharingGrantRecord> {
    return await this.prismaClient.notetakerSharingGrant.create({
      data: { bookingId: data.bookingId, grantedByUserId: data.grantedByUserId },
      select: sharingGrantSelect,
    });
  }

  async deleteSharingGrant(bookingId: number): Promise<boolean> {
    const { count } = await this.prismaClient.notetakerSharingGrant.deleteMany({
      where: { bookingId },
    });
    return count > 0;
  }

  async findVerifiedEmailsByUserId(userId: number): Promise<string[]> {
    const user = await this.prismaClient.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        secondaryEmails: {
          where: { emailVerified: { not: null } },
          select: { email: true },
        },
      },
    });
    if (!user) return [];
    return [user.email, ...user.secondaryEmails.map((secondary) => secondary.email)];
  }
}
