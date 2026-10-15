import type { NotetakerSharingModeDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import type { NotetakerChoiceSourceDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { NOTETAKER_AD_HOC_KEY, readAdHocBookingMetadata } from "../lib/adHocMeeting";
import { deriveNotetakerSharingTeam } from "../lib/sharingScope";
import type {
  BookingNotetakerRecord,
  IBookingNotetakerRepository,
  NotetakerAttendeeRecord,
  NotetakerBookingContext,
  NotetakerBookingReferenceRecord,
  NotetakerBookingStatus,
  NotetakerBookingWithResultsSessionRecord,
  NotetakerSeriesBookingRecord,
  NotetakerSharingGrantRecord,
  NotetakerWebPushSubscriptionRecord,
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

const attendeeSelect = {
  email: true,
  name: true,
  locale: true,
  timeZone: true,
} satisfies Prisma.AttendeeSelect;

const bookingReferenceSelect = {
  type: true,
  uid: true,
  externalCalendarId: true,
  credentialId: true,
  delegationCredentialId: true,
} satisfies Prisma.BookingReferenceSelect;

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
      userId: true,
      team: { select: { id: true, name: true, parentId: true } },
      notetakerSettings: {
        select: { sharingMode: true, sharingTeam: { select: { id: true, name: true } } },
      },
    },
  },
  user: { select: { id: true, name: true, email: true, locale: true } },
} satisfies Prisma.BookingSelect;

const resultsSessionBookingSelect = {
  id: true,
  uid: true,
  title: true,
  startTime: true,
  eventTypeId: true,
  userId: true,
  user: { select: { name: true } },
  attendees: { select: { email: true } },
  notetakerSessions: {
    where: { transcript: { isNot: null } },
    orderBy: [{ dispatchedAt: "desc" }, { id: "desc" }],
    take: 1,
    select: {
      id: true,
      colleagueSharingDisclosed: true,
      resultsDeletedAt: true,
      transcript: { select: { summary: { select: { status: true } } } },
    },
  },
} satisfies Prisma.BookingSelect;

const bookingContextSelect = {
  ...bookingBaseSelect,
  notetaker: { select: choiceSelect },
} satisfies Prisma.BookingSelect;

type BookingBaseRow = Prisma.BookingGetPayload<{ select: typeof bookingBaseSelect }>;
type ChosenTeam = { id: number; name: string };

const adHocFilter = { path: [NOTETAKER_AD_HOC_KEY], equals: "true" } satisfies Prisma.JsonNullableFilter;

function chosenTeamIdOf(booking: BookingBaseRow): number | null {
  if (booking.eventType) return null;
  return readAdHocBookingMetadata(booking.metadata).sharingTeamId;
}

function toBookingContext(
  booking: BookingBaseRow,
  choice: BookingNotetakerRecord | null,
  teamsById: Map<number, ChosenTeam>
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

  // An ad-hoc booking has no event type, so its chosen team travels in the booking metadata.
  const adHocTeamId = chosenTeamIdOf(booking);
  const adHocTeam = adHocTeamId !== null ? (teamsById.get(adHocTeamId) ?? null) : null;
  const sharingTeam = deriveNotetakerSharingTeam({
    eventTypeTeam: booking.eventType?.team ?? null,
    eventTypeUserId: booking.eventType?.userId ?? (adHocTeam ? booking.userId : null),
    chosenTeam: booking.eventType?.notetakerSettings?.sharingTeam ?? adHocTeam,
  });

  // Ad-hoc bookings have no settings row; having a resolved team is what makes them shared.
  let sharingMode: NotetakerSharingModeDto = "HOSTS_ONLY";
  if (booking.eventType) {
    sharingMode = booking.eventType.notetakerSettings?.sharingMode ?? "HOSTS_ONLY";
  } else if (sharingTeam.teamId !== null) {
    sharingMode = "TEAM";
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
    ...sharingTeam,
    sharingMode,
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

  private async findChosenTeams(bookings: BookingBaseRow[]): Promise<Map<number, ChosenTeam>> {
    const ids = new Set<number>();
    for (const booking of bookings) {
      const teamId = chosenTeamIdOf(booking);
      if (teamId !== null) ids.add(teamId);
    }
    if (ids.size === 0) return new Map();
    const teams = await this.prismaClient.team.findMany({
      where: { id: { in: Array.from(ids) } },
      select: { id: true, name: true },
    });
    return new Map(teams.map((team) => [team.id, team]));
  }

  async findByBookingUidIncludeBooking(bookingUid: string): Promise<NotetakerBookingContext | null> {
    const row = await this.prismaClient.booking.findUnique({
      where: { uid: bookingUid },
      select: bookingContextSelect,
    });
    if (!row) return null;
    return toBookingContext(row, row.notetaker, await this.findChosenTeams([row]));
  }

  async findByBookingIdIncludeBooking(bookingId: number): Promise<NotetakerBookingContext | null> {
    const row = await this.prismaClient.booking.findUnique({
      where: { id: bookingId },
      select: bookingContextSelect,
    });
    if (!row) return null;
    return toBookingContext(row, row.notetaker, await this.findChosenTeams([row]));
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

  async enableIfDisabled(data: {
    bookingId: number;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByUserId: number | null;
    setAt: Date;
  }): Promise<boolean> {
    // Each branch is a single conditional statement, which is what makes exactly one caller win;
    // a read-then-write would let two hosts both arm the booking. skipDuplicates makes the loser of
    // the insert race get a count of 0 instead of a unique-violation. An already enabled or
    // rejoin-blocked row matches neither statement, so nothing is written.
    const { bookingId, source, appliedToSeries, setByUserId, setAt } = data;
    const updated = await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId, enabled: false, rejoinBlocked: false },
      data: { enabled: true, pendingDispatch: true, source, appliedToSeries, setByUserId, setAt },
    });
    if (updated.count === 1) return true;

    const created = await this.prismaClient.bookingNotetaker.createMany({
      data: [
        { bookingId, enabled: true, pendingDispatch: true, source, appliedToSeries, setByUserId, setAt },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async disable(bookingId: number): Promise<void> {
    await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId },
      data: { enabled: false, pendingDispatch: false },
    });
  }

  async disableIfEnabled(bookingId: number): Promise<boolean> {
    // The enabled filter makes this a single conditional UPDATE, so of two sweeps voiding the same
    // booking only one sees a count of 1 and writes the activity.
    const { count } = await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId, enabled: true },
      data: { enabled: false, pendingDispatch: false },
    });
    return count === 1;
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
    const teamsById = await this.findChosenTeams(rows.map((row) => row.booking));
    return rows.map(({ booking, ...choice }) => toBookingContext(booking, choice, teamsById));
  }

  async findByRecurringEventIdFromStartTime(params: {
    recurringEventId: string;
    startTimeGte: Date;
  }): Promise<NotetakerSeriesBookingRecord[]> {
    const rows = await this.prismaClient.booking.findMany({
      where: {
        recurringEventId: params.recurringEventId,
        startTime: { gte: params.startTimeGte },
      },
      select: {
        id: true,
        uid: true,
        startTime: true,
        endTime: true,
        status: true,
        notetaker: { select: choiceSelect },
      },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      bookingId: row.id,
      bookingUid: row.uid,
      startTime: row.startTime,
      endTime: row.endTime,
      status: row.status,
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

  async findAttendeesByBookingId(bookingId: number): Promise<NotetakerAttendeeRecord[]> {
    return await this.prismaClient.attendee.findMany({
      where: { bookingId },
      orderBy: { id: "asc" },
      select: attendeeSelect,
    });
  }

  async findReferencesByBookingIdAndType(params: {
    bookingId: number;
    type: string;
  }): Promise<NotetakerBookingReferenceRecord[]> {
    return await this.prismaClient.bookingReference.findMany({
      where: {
        bookingId: params.bookingId,
        type: params.type,
        // deleted is nullable and `{ not: true }` would drop NULL rows in SQL
        OR: [{ deleted: null }, { deleted: false }],
      },
      orderBy: { id: "asc" },
      select: bookingReferenceSelect,
    });
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
        emailVerified: true,
        secondaryEmails: {
          where: { emailVerified: { not: null } },
          select: { email: true },
        },
      },
    });
    if (!user) return [];
    return [
      ...(user.emailVerified !== null ? [user.email] : []),
      ...user.secondaryEmails.map((secondary) => secondary.email),
    ];
  }

  async findWebPushSubscriptionsByUserIds(userIds: number[]): Promise<NotetakerWebPushSubscriptionRecord[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prismaClient.notificationsSubscriptions.findMany({
      where: { userId: { in: userIds } },
      orderBy: { id: "desc" },
      select: { userId: true, subscription: true },
    });
    // The table has no unique constraint on userId; rows arrive newest first, so the first one seen
    // per user is the one to keep.
    const latestByUserId = new Map<number, NotetakerWebPushSubscriptionRecord>();
    rows.forEach((row) => {
      if (!latestByUserId.has(row.userId)) latestByUserId.set(row.userId, row);
    });
    const result: NotetakerWebPushSubscriptionRecord[] = [];
    Array.from(new Set(userIds)).forEach((userId) => {
      const latest = latestByUserId.get(userId);
      if (latest) result.push(latest);
    });
    return result;
  }

  async setAppliedToSeries(bookingId: number, appliedToSeries: boolean): Promise<void> {
    await this.prismaClient.bookingNotetaker.updateMany({
      where: { bookingId },
      data: { appliedToSeries },
    });
  }

  async createSharingGrantIfMissing(data: {
    bookingId: number;
    grantedByUserId: number | null;
  }): Promise<boolean> {
    // The insert itself decides who shared: a duplicate is skipped by the database instead of
    // read first, so concurrent calls get exactly one true.
    const { count } = await this.prismaClient.notetakerSharingGrant.createMany({
      data: [{ bookingId: data.bookingId, grantedByUserId: data.grantedByUserId }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async findByEventTypeIdsIncludeResultsSession(params: {
    eventTypeIds: number[];
    cursor: { startTime: Date; id: number } | null;
    limit: number;
  }): Promise<NotetakerBookingWithResultsSessionRecord[]> {
    const { eventTypeIds, cursor, limit } = params;
    if (eventTypeIds.length === 0) return [];

    const rows = await this.prismaClient.booking.findMany({
      where: {
        eventTypeId: { in: eventTypeIds },
        notetakerSessions: { some: { colleagueSharingDisclosed: true, transcript: { isNot: null } } },
        ...(cursor
          ? {
              OR: [
                { startTime: { lt: cursor.startTime } },
                { startTime: cursor.startTime, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startTime: "desc" }, { id: "desc" }],
      take: limit,
      select: resultsSessionBookingSelect,
    });

    const records: NotetakerBookingWithResultsSessionRecord[] = [];
    for (const row of rows) {
      // The where clause guarantees an event type; the null check narrows the type.
      if (row.eventTypeId === null) continue;
      const [session] = row.notetakerSessions;
      records.push({
        bookingId: row.id,
        bookingUid: row.uid,
        title: row.title,
        startTime: row.startTime,
        eventTypeId: row.eventTypeId,
        organizerUserId: row.userId,
        organizerName: row.user?.name ?? null,
        attendeeEmails: row.attendees.map((attendee) => attendee.email),
        resultsSession: session
          ? {
              id: session.id,
              colleagueSharingDisclosed: session.colleagueSharingDisclosed,
              resultsDeletedAt: session.resultsDeletedAt,
              summaryStatus: session.transcript?.summary?.status ?? null,
            }
          : null,
      });
    }
    return records;
  }

  async createAdHocBooking(data: {
    uid: string;
    userId: number;
    title: string;
    startTime: Date;
    endTime: Date;
    location: string;
    metadata: Record<string, string>;
  }): Promise<{ id: number; uid: string }> {
    return await this.prismaClient.booking.create({
      data: {
        uid: data.uid,
        userId: data.userId,
        title: data.title,
        startTime: data.startTime,
        endTime: data.endTime,
        location: data.location,
        metadata: data.metadata,
        status: "ACCEPTED",
      },
      select: { id: true, uid: true },
    });
  }

  async countAdHocByUserIdSince(params: { userId: number; since: Date }): Promise<number> {
    return await this.prismaClient.booking.count({
      where: { userId: params.userId, createdAt: { gte: params.since }, metadata: adHocFilter },
    });
  }

  async findActiveAdHocByUserId(params: {
    userId: number;
    now: Date;
  }): Promise<{ bookingUid: string; location: string | null }[]> {
    const rows = await this.prismaClient.booking.findMany({
      where: {
        userId: params.userId,
        status: "ACCEPTED",
        endTime: { gt: params.now },
        metadata: adHocFilter,
      },
      orderBy: { id: "asc" },
      select: { uid: true, location: true },
    });
    return rows.map((row) => ({ bookingUid: row.uid, location: row.location }));
  }
}
