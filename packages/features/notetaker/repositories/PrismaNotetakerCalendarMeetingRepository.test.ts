import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaNotetakerCalendarMeetingRepository } from "./PrismaNotetakerCalendarMeetingRepository";

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function buildRepository(overrides: Record<string, unknown> = {}) {
  const tx = {
    booking: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    attendee: { findFirst: vi.fn(), create: vi.fn() },
    notetakerActivity: { create: vi.fn() },
    notetakerCalendarMeeting: { create: vi.fn(), update: vi.fn() },
    notetakerCalendarMeetingParticipant: { upsert: vi.fn() },
    bookingNotetaker: { upsert: vi.fn() },
    ...overrides,
  };
  const findFirst = vi.fn();
  const prismaClient = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => await callback(tx)),
    booking: { findFirst },
  } as unknown as PrismaClient;
  return { repository: new PrismaNotetakerCalendarMeetingRepository(prismaClient), tx, findFirst };
}

const startTime = new Date("2026-11-05T10:00:00.000Z");
const createParams = {
  bookingUid: "uid-1",
  title: "Sync",
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  meetingKey: "GOOGLE_MEET:abc-defg-hij",
  startTime,
  endTime: new Date("2026-11-05T11:00:00.000Z"),
  iCalUID: "ical-1",
  metadata: {},
  owner: {
    userId: 1,
    email: "o@x.com",
    name: "Owner",
    timeZone: "UTC",
    selectedCalendarId: "sc-1",
    externalEventId: "evt-1",
  },
  seenAt: new Date("2026-11-04T10:00:00.000Z"),
};

describe("PrismaNotetakerCalendarMeetingRepository.createWithBooking", () => {
  it("maps a (meetingKey, startTime) unique violation to CONFLICT", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.create.mockResolvedValue({ id: 10 });
    tx.notetakerCalendarMeeting.create.mockRejectedValue(uniqueViolation());

    await expect(repository.createWithBooking(createParams)).resolves.toBe("CONFLICT");
  });

  it("rethrows other errors", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.create.mockRejectedValue(new Error("db down"));

    await expect(repository.createWithBooking(createParams)).rejects.toThrow("db down");
  });

  it("creates the booking with an armed calendar choice and a system activity", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.create.mockResolvedValue({ id: 10 });
    tx.notetakerCalendarMeeting.create.mockResolvedValue({
      id: "m-1",
      bookingId: 10,
      ownerUserId: 1,
      meetingKey: createParams.meetingKey,
      startTime,
      endTime: createParams.endTime,
      booking: { uid: "uid-1", notetakerSessions: [] },
      participants: [],
    });

    const record = await repository.createWithBooking(createParams);

    expect(tx.booking.create.mock.calls[0][0].data).toMatchObject({
      userId: 1,
      status: "ACCEPTED",
      location: createParams.meetingUrl,
      notetaker: {
        create: { enabled: true, pendingDispatch: true, source: "CALENDAR_AUTO_JOIN", setByUserId: null },
      },
    });
    expect(tx.notetakerActivity.create.mock.calls[0][0].data).toMatchObject({
      bookingId: 10,
      action: "ENABLED",
      actorType: "SYSTEM",
    });
    expect(record).toMatchObject({ id: "m-1", bookingUid: "uid-1", hasSession: false });
  });
});

describe("PrismaNotetakerCalendarMeetingRepository.upsertParticipant", () => {
  const params = {
    meetingId: "m-1",
    bookingId: 10,
    userId: 2,
    email: "p@x.com",
    name: "P",
    timeZone: "UTC",
    selectedCalendarId: "sc-2",
    externalEventId: "evt-2",
    seenAt: new Date("2026-11-04T10:00:00.000Z"),
  };

  it("clears removedAt when reviving the participant", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.findUnique.mockResolvedValue({ userId: 1 });
    tx.attendee.findFirst.mockResolvedValue({ id: 1 });

    await repository.upsertParticipant(params);

    expect(tx.notetakerCalendarMeetingParticipant.upsert.mock.calls[0][0].update).toMatchObject({
      removedAt: null,
    });
  });

  it("adds an attendee when the email is not listed yet", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.findUnique.mockResolvedValue({ userId: 1 });
    tx.attendee.findFirst.mockResolvedValue(null);

    await repository.upsertParticipant(params);

    expect(tx.attendee.findFirst.mock.calls[0][0].where).toEqual({
      bookingId: 10,
      email: { equals: "p@x.com", mode: "insensitive" },
    });
    expect(tx.attendee.create).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an existing attendee", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.findUnique.mockResolvedValue({ userId: 1 });
    tx.attendee.findFirst.mockResolvedValue({ id: 5 });

    await repository.upsertParticipant(params);

    expect(tx.attendee.create).not.toHaveBeenCalled();
  });

  it("does not add the booking owner as an attendee", async () => {
    const { repository, tx } = buildRepository();
    tx.booking.findUnique.mockResolvedValue({ userId: 2 });

    await repository.upsertParticipant(params);

    expect(tx.attendee.findFirst).not.toHaveBeenCalled();
    expect(tx.attendee.create).not.toHaveBeenCalled();
  });
});

describe("PrismaNotetakerCalendarMeetingRepository.reschedule", () => {
  it("returns CONFLICT on a unique violation", async () => {
    const { repository, tx } = buildRepository();
    tx.notetakerCalendarMeeting.update.mockRejectedValue(uniqueViolation());

    await expect(
      repository.reschedule({
        meetingId: "m-1",
        bookingId: 10,
        startTime,
        endTime: startTime,
        meetingUrl: "u",
        meetingKey: "k",
      })
    ).resolves.toBe("CONFLICT");
  });
});

describe("PrismaNotetakerCalendarMeetingRepository.findCalDiyBookingForEvent", () => {
  it("matches by iCalUID or live booking reference and excludes cancelled and calendar meetings", async () => {
    const { repository, findFirst } = buildRepository();
    findFirst.mockResolvedValue(null);

    await repository.findCalDiyBookingForEvent({ iCalUID: "ical-1", externalEventId: "evt-1" });

    expect(findFirst.mock.calls[0][0].where).toEqual({
      status: { notIn: ["CANCELLED", "REJECTED"] },
      notetakerCalendarMeeting: null,
      OR: [
        { references: { some: { uid: "evt-1", OR: [{ deleted: null }, { deleted: false }] } } },
        { iCalUID: "ical-1" },
      ],
    });
  });

  it("never matches on an empty iCalUID", async () => {
    const { repository, findFirst } = buildRepository();
    findFirst.mockResolvedValue(null);

    await repository.findCalDiyBookingForEvent({ iCalUID: null, externalEventId: "evt-1" });

    expect(findFirst.mock.calls[0][0].where.OR).toHaveLength(1);
  });

  it("reports host and whether a choice exists", async () => {
    const { repository, findFirst } = buildRepository();
    findFirst.mockResolvedValue({ id: 4, userId: 9, notetaker: { bookingId: 4 } });

    await expect(
      repository.findCalDiyBookingForEvent({ iCalUID: null, externalEventId: "evt-1" })
    ).resolves.toEqual({ bookingId: 4, hostUserId: 9, hasNotetakerChoice: true });
  });
});

describe("PrismaNotetakerCalendarMeetingRepository.listActiveParticipantUserIds", () => {
  it("lists the user ids of participants not removed from the booking's meeting", async () => {
    const findMany = vi.fn().mockResolvedValue([{ userId: 1 }, { userId: 7 }]);
    const prismaClient = { notetakerCalendarMeetingParticipant: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaNotetakerCalendarMeetingRepository(prismaClient);

    await expect(repository.listActiveParticipantUserIds({ bookingId: 10 })).resolves.toEqual([1, 7]);
    expect(findMany).toHaveBeenCalledWith({
      where: { removedAt: null, meeting: { bookingId: 10 } },
      select: { userId: true },
    });
  });
});

describe("PrismaNotetakerCalendarMeetingRepository.revive", () => {
  const params = {
    meetingId: "m-1",
    bookingId: 10,
    userId: 2,
    email: "p@x.com",
    name: "P",
    timeZone: "UTC",
    selectedCalendarId: "sc-2",
    externalEventId: "evt-2",
    seenAt: new Date("2026-11-04T10:00:00.000Z"),
  };

  it("accepts the booking under the user, re-arms the choice, logs a system activity and revives the participant", async () => {
    const { repository, tx } = buildRepository();

    await repository.revive(params);

    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: "ACCEPTED", userId: 2 },
      select: { id: true },
    });
    expect(tx.notetakerCalendarMeeting.update).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: { ownerUserId: 2 },
      select: { id: true },
    });
    const choice = {
      enabled: true,
      pendingDispatch: true,
      rejoinBlocked: false,
      source: "CALENDAR_AUTO_JOIN",
      setByUserId: null,
      setAt: params.seenAt,
    };
    expect(tx.bookingNotetaker.upsert).toHaveBeenCalledWith({
      where: { bookingId: 10 },
      create: { bookingId: 10, ...choice },
      update: choice,
      select: { bookingId: true },
    });
    expect(tx.notetakerActivity.create.mock.calls[0][0].data).toMatchObject({
      bookingId: 10,
      action: "ENABLED",
      actorType: "SYSTEM",
      detail: { source: "CALENDAR_AUTO_JOIN" },
    });
    const upsert = tx.notetakerCalendarMeetingParticipant.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ meetingId_userId: { meetingId: "m-1", userId: 2 } });
    expect(upsert.update).toEqual({
      selectedCalendarId: "sc-2",
      externalEventId: "evt-2",
      lastSeenAt: params.seenAt,
      removedAt: null,
    });
  });
});
