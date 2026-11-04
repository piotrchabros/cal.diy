import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaExternalCalendarEventsRepository } from "./PrismaExternalCalendarEventsRepository";

const LIVE_STATUS_FILTER = { notIn: ["CANCELLED", "REJECTED"] };
const LIVE_REFERENCE_FILTER = { OR: [{ deleted: null }, { deleted: false }] };

function buildRepository(model: string, rows: unknown[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prismaClient = { [model]: { findMany } } as unknown as PrismaClient;
  return { repository: new PrismaExternalCalendarEventsRepository(prismaClient), findMany };
}

describe("PrismaExternalCalendarEventsRepository.findUserLevelSelectedCalendarsByIntegrations", () => {
  it("lists the user's calendars without an event type for the given integrations, ordered deterministically", async () => {
    const { repository, findMany } = buildRepository("selectedCalendar");

    await repository.findUserLevelSelectedCalendarsByIntegrations({
      userId: 7,
      integrations: ["google_calendar", "office365_calendar"],
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: 7,
      eventTypeId: null,
      integration: { in: ["google_calendar", "office365_calendar"] },
    });
    expect(args.orderBy).toEqual([{ integration: "asc" }, { externalId: "asc" }]);
    expect(args.select).toEqual({
      id: true,
      integration: true,
      externalId: true,
      credentialId: true,
      delegationCredentialId: true,
    });
  });

  it("skips the query when no integration is supported", async () => {
    const { repository, findMany } = buildRepository("selectedCalendar");

    await expect(
      repository.findUserLevelSelectedCalendarsByIntegrations({ userId: 7, integrations: [] })
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("renames id to selectedCalendarId", async () => {
    const { repository } = buildRepository("selectedCalendar", [
      {
        id: "sc-1",
        integration: "google_calendar",
        externalId: "a@b.c",
        credentialId: 5,
        delegationCredentialId: null,
      },
    ]);

    await expect(
      repository.findUserLevelSelectedCalendarsByIntegrations({
        userId: 7,
        integrations: ["google_calendar"],
      })
    ).resolves.toEqual([
      {
        selectedCalendarId: "sc-1",
        integration: "google_calendar",
        externalId: "a@b.c",
        credentialId: 5,
        delegationCredentialId: null,
      },
    ]);
  });
});

describe("PrismaExternalCalendarEventsRepository.findLiveBookingMatchKeysForUser", () => {
  it("matches live bookings hosted or attended by the user by iCalUID or live reference uid", async () => {
    const { repository, findMany } = buildRepository("booking");

    await repository.findLiveBookingMatchKeysForUser({
      userId: 7,
      userEmail: "Me@Example.com",
      iCalUIDs: ["ical-1"],
      referenceUids: ["ext-1", "rec-1"],
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      status: LIVE_STATUS_FILTER,
      AND: [
        {
          OR: [
            { userId: 7 },
            { attendees: { some: { email: { equals: "Me@Example.com", mode: "insensitive" } } } },
          ],
        },
        {
          OR: [
            { iCalUID: { in: ["ical-1"] } },
            { references: { some: { uid: { in: ["ext-1", "rec-1"] }, ...LIVE_REFERENCE_FILTER } } },
          ],
        },
      ],
    });
    expect(args.select).toEqual({
      iCalUID: true,
      references: {
        where: { uid: { in: ["ext-1", "rec-1"] }, ...LIVE_REFERENCE_FILTER },
        select: { uid: true },
      },
    });
  });

  it("drops empty iCalUIDs and does not select references when no reference uid is given", async () => {
    const { repository, findMany } = buildRepository("booking");

    await repository.findLiveBookingMatchKeysForUser({
      userId: 7,
      userEmail: "me@example.com",
      iCalUIDs: ["", "ical-1", "ical-1"],
      referenceUids: [""],
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where.AND[1]).toEqual({ OR: [{ iCalUID: { in: ["ical-1"] } }] });
    expect(args.select).toEqual({ iCalUID: true, references: false });
  });

  it("skips the query when every key is empty", async () => {
    const { repository, findMany } = buildRepository("booking");

    await expect(
      repository.findLiveBookingMatchKeysForUser({
        userId: 7,
        userEmail: "me@example.com",
        iCalUIDs: [""],
        referenceUids: [],
      })
    ).resolves.toEqual({ iCalUIDs: [], referenceUids: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns only the requested keys that matched, deduplicated", async () => {
    const { repository } = buildRepository("booking", [
      { iCalUID: "ical-1", references: [{ uid: "ext-1" }] },
      { iCalUID: "ical-1", references: [{ uid: "ext-1" }, { uid: "rec-1" }] },
      { iCalUID: "unrelated", references: [] },
      { iCalUID: "", references: undefined },
    ]);

    await expect(
      repository.findLiveBookingMatchKeysForUser({
        userId: 7,
        userEmail: "me@example.com",
        iCalUIDs: ["ical-1", "ical-2"],
        referenceUids: ["ext-1", "rec-1", "ext-2"],
      })
    ).resolves.toEqual({ iCalUIDs: ["ical-1"], referenceUids: ["ext-1", "rec-1"] });
  });
});

describe("PrismaExternalCalendarEventsRepository.findActiveCalendarMeetingEventKeysByUserId", () => {
  it("lists the user's active participations for the given calendars", async () => {
    const rows = [{ selectedCalendarId: "sc-1", externalEventId: "ext-1" }];
    const { repository, findMany } = buildRepository("notetakerCalendarMeetingParticipant", rows);

    await expect(
      repository.findActiveCalendarMeetingEventKeysByUserId({
        userId: 7,
        selectedCalendarIds: ["sc-1", "sc-2"],
      })
    ).resolves.toEqual(rows);

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 7, removedAt: null, selectedCalendarId: { in: ["sc-1", "sc-2"] } });
    expect(args.select).toEqual({ selectedCalendarId: true, externalEventId: true });
  });

  it("skips the query when there is no calendar", async () => {
    const { repository, findMany } = buildRepository("notetakerCalendarMeetingParticipant");

    await expect(
      repository.findActiveCalendarMeetingEventKeysByUserId({ userId: 7, selectedCalendarIds: [] })
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("PrismaExternalCalendarEventsRepository.findLiveBookingLocationsByUserIdInRange", () => {
  const from = new Date("2026-11-04T10:00:00.000Z");
  const to = new Date("2026-11-11T10:00:00.000Z");

  it("matches the user's live bookings at one of the locations overlapping the range", async () => {
    const { repository, findMany } = buildRepository("booking", [
      { location: "https://meet.google.com/abc-defg-hij", startTime: from, endTime: to },
    ]);

    await expect(
      repository.findLiveBookingLocationsByUserIdInRange({
        userId: 7,
        locations: ["https://meet.google.com/abc-defg-hij", "", "https://meet.google.com/abc-defg-hij"],
        from,
        to,
      })
    ).resolves.toEqual([{ location: "https://meet.google.com/abc-defg-hij", startTime: from, endTime: to }]);

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: 7,
      status: LIVE_STATUS_FILTER,
      location: { in: ["https://meet.google.com/abc-defg-hij"] },
      startTime: { lt: to },
      endTime: { gt: from },
    });
    expect(args.select).toEqual({ location: true, startTime: true, endTime: true });
  });

  it("skips the query when there is no location", async () => {
    const { repository, findMany } = buildRepository("booking");

    await expect(
      repository.findLiveBookingLocationsByUserIdInRange({ userId: 7, locations: [""], from, to })
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
