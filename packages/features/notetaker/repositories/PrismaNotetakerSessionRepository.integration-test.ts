import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import type { NotetakerSessionCreateInput } from "./interfaces/INotetakerSessionRepository";
import { PrismaNotetakerSessionRepository } from "./PrismaNotetakerSessionRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = "notetaker-session-it-";

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaNotetakerSessionRepository (integration)";

const repository = new PrismaNotetakerSessionRepository(prisma);

const startTime = new Date("2030-04-01T10:00:00.000Z");

let userId: number | undefined;
let bookingId: number | undefined;
let otherBookingId: number | undefined;
let bookingCounter = 0;

function requireBookingId(): number {
  if (bookingId === undefined) {
    throw new Error("Test setup did not complete: booking id is missing");
  }
  return bookingId;
}

async function createBooking(): Promise<number> {
  if (userId === undefined) throw new Error("Test user was not created");
  bookingCounter += 1;
  const booking = await prisma.booking.create({
    data: {
      uid: `${prefix}${runId}-${bookingCounter}`,
      title: "Notetaker session integration test",
      startTime,
      endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
      userId,
    },
    select: { id: true },
  });
  return booking.id;
}

function sessionInput(
  forBookingId: number,
  overrides: Partial<NotetakerSessionCreateInput> = {}
): NotetakerSessionCreateInput {
  return {
    bookingId: forBookingId,
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botProvider: "FAKE",
    displayName: "Notetaker",
    scheduledStartAt: startTime,
    ...overrides,
  };
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `${prefix}${runId}@example.com`,
        username: `${prefix}${runId}`,
      },
      select: { id: true },
    });
    userId = user.id;
  });

  beforeEach(async () => {
    bookingId = await createBooking();
  });

  afterEach(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    // Sessions, transcripts and passages cascade with the booking.
    if (bookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    }
    bookingId = undefined;
    if (otherBookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: otherBookingId } });
    }
    otherBookingId = undefined;
  });

  afterAll(async () => {
    if (userId !== undefined) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    userId = undefined;
  });

  it("stores colleagueSharingDisclosed as false by default and as true when given", async () => {
    const defaulted = await repository.create(sessionInput(requireBookingId()));
    const disclosed = await repository.create(
      sessionInput(requireBookingId(), { colleagueSharingDisclosed: true })
    );

    expect(defaulted.colleagueSharingDisclosed).toBe(false);
    expect(disclosed.colleagueSharingDisclosed).toBe(true);
    expect((await repository.findById(defaulted.id))?.colleagueSharingDisclosed).toBe(false);
    expect((await repository.findById(disclosed.id))?.colleagueSharingDisclosed).toBe(true);
  });

  it("keeps colleagueSharingDisclosed when another field is updated", async () => {
    const session = await repository.create(
      sessionInput(requireBookingId(), { colleagueSharingDisclosed: true })
    );

    await repository.update(session.id, { status: "TRANSCRIBING" });

    const stored = await repository.findById(session.id);
    expect(stored?.status).toBe("TRANSCRIBING");
    expect(stored?.colleagueSharingDisclosed).toBe(true);
  });

  it("findEarliestByBookingId resolves null for a booking without sessions", async () => {
    expect(await repository.findEarliestByBookingId(requireBookingId())).toBeNull();
  });

  it("orders the earliest session by createdAt, which differs from the dispatchedAt order of the latest", async () => {
    const bookingIdValue = requireBookingId();
    const c1 = new Date("2030-04-01T09:00:00.000Z");
    const c2 = new Date("2030-04-01T09:05:00.000Z");
    const c3 = new Date("2030-04-01T09:10:00.000Z");

    // The session created first gets the latest dispatchedAt.
    const first = await repository.create(
      sessionInput(bookingIdValue, { dispatchedAt: new Date("2030-04-01T09:30:00.000Z") })
    );
    const second = await repository.create(
      sessionInput(bookingIdValue, { dispatchedAt: new Date("2030-04-01T09:10:00.000Z") })
    );
    const third = await repository.create(
      sessionInput(bookingIdValue, { dispatchedAt: new Date("2030-04-01T09:20:00.000Z") })
    );
    await prisma.notetakerSession.update({ where: { id: first.id }, data: { createdAt: c1 } });
    await prisma.notetakerSession.update({ where: { id: second.id }, data: { createdAt: c2 } });
    await prisma.notetakerSession.update({ where: { id: third.id }, data: { createdAt: c3 } });

    const earliest = await repository.findEarliestByBookingId(bookingIdValue);
    const latest = await repository.findLatestByBookingId(bookingIdValue);

    expect(earliest?.id).toBe(first.id);
    expect(earliest?.createdAt).toStrictEqual(c1);
    expect(latest?.id).toBe(first.id);
  });

  it("breaks a createdAt tie by id ascending", async () => {
    const bookingIdValue = requireBookingId();
    const createdAt = new Date("2030-04-01T09:00:00.000Z");
    const idA = `${prefix}${runId}-a`;
    const idB = `${prefix}${runId}-b`;

    // Created in the reverse order so the result cannot come from insertion order.
    for (const id of [idB, idA]) {
      await prisma.notetakerSession.create({
        data: {
          id,
          bookingId: bookingIdValue,
          platform: "GOOGLE_MEET",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          botProvider: "FAKE",
          displayName: "Notetaker",
          scheduledStartAt: startTime,
          createdAt,
        },
        select: { id: true },
      });
    }

    const earliest = await repository.findEarliestByBookingId(bookingIdValue);

    expect(earliest?.id).toBe(idA);
  });

  it("ignores the sessions of another booking", async () => {
    otherBookingId = await createBooking();
    const other = await repository.create(sessionInput(otherBookingId));

    expect(await repository.findEarliestByBookingId(requireBookingId())).toBeNull();

    const own = await repository.create(sessionInput(requireBookingId()));
    await prisma.notetakerSession.update({
      where: { id: own.id },
      data: { createdAt: new Date("2030-04-01T12:00:00.000Z") },
    });
    await prisma.notetakerSession.update({
      where: { id: other.id },
      data: { createdAt: new Date("2030-04-01T08:00:00.000Z") },
    });

    expect((await repository.findEarliestByBookingId(requireBookingId()))?.id).toBe(own.id);
    expect((await repository.findEarliestByBookingId(otherBookingId))?.id).toBe(other.id);
  });

  it("carries colleagueSharingDisclosed on the record that the earliest and latest lookups return", async () => {
    const session = await repository.create(
      sessionInput(requireBookingId(), { colleagueSharingDisclosed: true })
    );

    expect((await repository.findEarliestByBookingId(requireBookingId()))?.colleagueSharingDisclosed).toBe(
      true
    );
    expect((await repository.findLatestByBookingId(requireBookingId()))?.id).toBe(session.id);
    expect((await repository.findLatestByBookingId(requireBookingId()))?.colleagueSharingDisclosed).toBe(
      true
    );
  });

  it("returns speakerNamesAvailable of the transcript as stored", async () => {
    const session = await repository.create(sessionInput(requireBookingId()));
    const transcript = await prisma.notetakerTranscript.create({
      data: { sessionId: session.id, bookingId: requireBookingId() },
      select: { id: true },
    });

    const beforeUpdate = await repository.findLatestWithTranscriptByBookingId(requireBookingId());
    expect(beforeUpdate?.transcript.speakerNamesAvailable).toBeNull();

    await prisma.notetakerTranscript.update({
      where: { id: transcript.id },
      data: { speakerNamesAvailable: false },
    });

    const afterUpdate = await repository.findLatestWithTranscriptByBookingId(requireBookingId());
    expect(afterUpdate?.transcript.speakerNamesAvailable).toBe(false);
  });
});
