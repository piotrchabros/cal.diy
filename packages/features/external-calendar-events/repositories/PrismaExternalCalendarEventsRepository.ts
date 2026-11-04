import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { BookingStatus } from "@calcom/prisma/enums";
import type { ExternalCalendarRef } from "../lib/externalCalendarEvents";
import type {
  ExternalCalendarBookedLocation,
  ExternalCalendarBookingMatchKeys,
  ExternalCalendarMeetingEventKey,
  IExternalCalendarEventsRepository,
} from "./interfaces/IExternalCalendarEventsRepository";

const LIVE_BOOKING_STATUS_FILTER = { notIn: [BookingStatus.CANCELLED, BookingStatus.REJECTED] };

const selectedCalendarSelect = {
  id: true,
  integration: true,
  externalId: true,
  credentialId: true,
  delegationCredentialId: true,
} satisfies Prisma.SelectedCalendarSelect;

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value !== "")));
}

export class PrismaExternalCalendarEventsRepository implements IExternalCalendarEventsRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findUserLevelSelectedCalendarsByIntegrations(params: {
    userId: number;
    integrations: string[];
  }): Promise<ExternalCalendarRef[]> {
    if (params.integrations.length === 0) return [];

    const rows = await this.prismaClient.selectedCalendar.findMany({
      where: { userId: params.userId, eventTypeId: null, integration: { in: params.integrations } },
      orderBy: [{ integration: "asc" }, { externalId: "asc" }],
      select: selectedCalendarSelect,
    });
    return rows.map(({ id, ...row }) => ({ selectedCalendarId: id, ...row }));
  }

  async findLiveBookingMatchKeysForUser(params: {
    userId: number;
    userEmail: string;
    iCalUIDs: string[];
    referenceUids: string[];
  }): Promise<ExternalCalendarBookingMatchKeys> {
    // Bookings default iCalUID to "", so an empty value must never match.
    const iCalUIDs = uniqueNonEmpty(params.iCalUIDs);
    const referenceUids = uniqueNonEmpty(params.referenceUids);
    if (iCalUIDs.length === 0 && referenceUids.length === 0) return { iCalUIDs: [], referenceUids: [] };

    const liveReferences: Prisma.BookingReferenceWhereInput = {
      uid: { in: referenceUids },
      OR: [{ deleted: null }, { deleted: false }],
    };
    const matchers: Prisma.BookingWhereInput[] = [];
    if (iCalUIDs.length > 0) matchers.push({ iCalUID: { in: iCalUIDs } });
    if (referenceUids.length > 0) matchers.push({ references: { some: liveReferences } });

    const rows = await this.prismaClient.booking.findMany({
      where: {
        status: LIVE_BOOKING_STATUS_FILTER,
        AND: [
          {
            OR: [
              { userId: params.userId },
              { attendees: { some: { email: { equals: params.userEmail, mode: "insensitive" } } } },
            ],
          },
          { OR: matchers },
        ],
      },
      select: {
        iCalUID: true,
        references: referenceUids.length > 0 ? { where: liveReferences, select: { uid: true } } : false,
      },
    });

    const requestedICalUIDs = new Set(iCalUIDs);
    const matchedICalUIDs = new Set<string>();
    const matchedReferenceUids = new Set<string>();
    for (const row of rows) {
      if (row.iCalUID && requestedICalUIDs.has(row.iCalUID)) matchedICalUIDs.add(row.iCalUID);
      for (const reference of row.references ?? []) matchedReferenceUids.add(reference.uid);
    }
    return { iCalUIDs: Array.from(matchedICalUIDs), referenceUids: Array.from(matchedReferenceUids) };
  }

  async findActiveCalendarMeetingEventKeysByUserId(params: {
    userId: number;
    selectedCalendarIds: string[];
  }): Promise<ExternalCalendarMeetingEventKey[]> {
    if (params.selectedCalendarIds.length === 0) return [];

    return await this.prismaClient.notetakerCalendarMeetingParticipant.findMany({
      where: {
        userId: params.userId,
        removedAt: null,
        selectedCalendarId: { in: params.selectedCalendarIds },
      },
      select: { selectedCalendarId: true, externalEventId: true },
    });
  }

  async findLiveBookingLocationsByUserIdInRange(params: {
    userId: number;
    locations: string[];
    from: Date;
    to: Date;
  }): Promise<ExternalCalendarBookedLocation[]> {
    const locations = uniqueNonEmpty(params.locations);
    if (locations.length === 0) return [];

    const rows = await this.prismaClient.booking.findMany({
      where: {
        userId: params.userId,
        status: LIVE_BOOKING_STATUS_FILTER,
        location: { in: locations },
        startTime: { lt: params.to },
        endTime: { gt: params.from },
      },
      select: { location: true, startTime: true, endTime: true },
    });
    return rows.flatMap((row) =>
      row.location === null
        ? []
        : [{ location: row.location, startTime: row.startTime, endTime: row.endTime }]
    );
  }
}
