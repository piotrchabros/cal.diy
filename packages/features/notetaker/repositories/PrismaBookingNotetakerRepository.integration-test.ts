import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaBookingNotetakerRepository } from "./PrismaBookingNotetakerRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SEEDED_AT = new Date("2029-12-01T00:00:00.000Z");
const ENABLED_AT = new Date("2029-12-02T00:00:00.000Z");
const CONCURRENT_CALLS = 5;

const repository = new PrismaBookingNotetakerRepository(prisma);

let userId: number | undefined;
let bookingId: number | undefined;
let bookingCounter = 0;

function requireBookingId(): number {
  if (bookingId === undefined) {
    throw new Error("Test setup did not complete: booking id is missing");
  }
  return bookingId;
}

function enableInput(id: number, setAt: Date) {
  return {
    bookingId: id,
    source: "HOST" as const,
    appliedToSeries: false,
    setByUserId: userId ?? null,
    setAt,
  };
}

function readChoice(id: number) {
  return prisma.bookingNotetaker.findUnique({
    where: { bookingId: id },
    select: {
      enabled: true,
      pendingDispatch: true,
      rejoinBlocked: true,
      setAt: true,
      setByUserId: true,
      source: true,
      notifiedAttendeeEmails: true,
      attendeesNotifiedAt: true,
    },
  });
}

function countTrue(results: boolean[]): number {
  return results.filter((result) => result).length;
}

function enableConcurrently(id: number): Promise<boolean[]> {
  return Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, () => repository.enableIfDisabled(enableInput(id, ENABLED_AT)))
  );
}

describe("PrismaBookingNotetakerRepository (integration)", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `notetaker-choice-it-${runId}@example.com`,
        username: `notetaker-choice-it-${runId}`,
      },
      select: { id: true },
    });
    userId = user.id;
  });

  beforeEach(async () => {
    if (userId === undefined) throw new Error("Test user was not created");
    bookingCounter += 1;
    const startTime = new Date("2030-01-01T10:00:00.000Z");
    const booking = await prisma.booking.create({
      data: {
        uid: `notetaker-choice-it-${runId}-${bookingCounter}`,
        title: "Notetaker choice integration test",
        startTime,
        endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
        userId,
      },
      select: { id: true },
    });
    bookingId = booking.id;
  });

  afterEach(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    // Deleting the booking cascades to its BookingNotetaker and Attendee rows.
    if (bookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    }
    bookingId = undefined;
  });

  afterAll(async () => {
    if (userId !== undefined) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    userId = undefined;
  });

  describe("enableIfDisabled", () => {
    it("creates the row exactly once when five calls race on a booking without a choice", async () => {
      const id = requireBookingId();

      const results = await enableConcurrently(id);

      expect(countTrue(results)).toBe(1);
      expect(results.filter((result) => !result)).toHaveLength(CONCURRENT_CALLS - 1);
      expect(await readChoice(id)).toEqual({
        enabled: true,
        pendingDispatch: true,
        rejoinBlocked: false,
        setAt: ENABLED_AT,
        setByUserId: userId,
        source: "HOST",
        notifiedAttendeeEmails: [],
        attendeesNotifiedAt: null,
      });
      expect(await prisma.bookingNotetaker.count({ where: { bookingId: id } })).toBe(1);
    });

    it("flips a disabled row exactly once when five calls race", async () => {
      const id = requireBookingId();
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: false,
          pendingDispatch: false,
          source: "EVENT_TYPE_DEFAULT",
          setAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });

      const results = await enableConcurrently(id);

      expect(countTrue(results)).toBe(1);
      const choice = await readChoice(id);
      expect(choice?.enabled).toBe(true);
      expect(choice?.pendingDispatch).toBe(true);
      expect(choice?.source).toBe("HOST");
      expect(choice?.setAt).toEqual(ENABLED_AT);
      expect(choice?.setByUserId).toBe(userId);
    });

    it("writes nothing when the row is already enabled", async () => {
      const id = requireBookingId();
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: true,
          pendingDispatch: false,
          source: "HOST",
          setAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });

      const results = await enableConcurrently(id);

      expect(countTrue(results)).toBe(0);
      const choice = await readChoice(id);
      expect(choice?.setAt).toEqual(SEEDED_AT);
      expect(choice?.pendingDispatch).toBe(false);
    });

    it("refuses to re-enable a rejoin-blocked row", async () => {
      const id = requireBookingId();
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: false,
          rejoinBlocked: true,
          source: "HOST",
          setAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });

      const results = await enableConcurrently(id);

      expect(countTrue(results)).toBe(0);
      const choice = await readChoice(id);
      expect(choice?.enabled).toBe(false);
      expect(choice?.pendingDispatch).toBe(false);
      expect(choice?.rejoinBlocked).toBe(true);
      expect(choice?.setAt).toEqual(SEEDED_AT);
    });

    it("keeps the notified attendee list when it flips a disabled row", async () => {
      const id = requireBookingId();
      const notifiedEmails = [`a-${runId}@example.com`];
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: false,
          source: "HOST",
          setAt: SEEDED_AT,
          notifiedAttendeeEmails: notifiedEmails,
          attendeesNotifiedAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });

      const changed = await repository.enableIfDisabled(enableInput(id, ENABLED_AT));

      expect(changed).toBe(true);
      const choice = await readChoice(id);
      expect(choice?.notifiedAttendeeEmails).toEqual(notifiedEmails);
      expect(choice?.attendeesNotifiedAt).toEqual(SEEDED_AT);
      expect(choice?.rejoinBlocked).toBe(false);
    });
  });

  describe("findAttendeesByBookingId", () => {
    it("returns the attendees in id order", async () => {
      const id = requireBookingId();
      await prisma.attendee.create({
        data: {
          bookingId: id,
          email: `zed-${runId}@example.com`,
          name: "Zed",
          timeZone: "Europe/Warsaw",
          locale: "pl",
        },
        select: { id: true },
      });
      await prisma.attendee.create({
        data: {
          bookingId: id,
          email: `amy-${runId}@example.com`,
          name: "Amy",
          timeZone: "UTC",
          locale: null,
        },
        select: { id: true },
      });

      const attendees = await repository.findAttendeesByBookingId(id);

      expect(attendees).toEqual([
        { email: `zed-${runId}@example.com`, name: "Zed", locale: "pl", timeZone: "Europe/Warsaw" },
        { email: `amy-${runId}@example.com`, name: "Amy", locale: null, timeZone: "UTC" },
      ]);
    });

    it("returns an empty list for a booking without attendees", async () => {
      const id = requireBookingId();

      expect(await repository.findAttendeesByBookingId(id)).toEqual([]);
    });
  });
});
