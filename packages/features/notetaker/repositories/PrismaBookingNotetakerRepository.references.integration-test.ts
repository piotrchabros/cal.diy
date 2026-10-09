import { prisma } from "@calcom/prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import { PrismaBookingNotetakerRepository } from "./PrismaBookingNotetakerRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaBookingNotetakerRepository references (integration)";

const repository = new PrismaBookingNotetakerRepository(prisma);

let userId: number | undefined;
let bookingId: number | undefined;
let otherBookingId: number | undefined;
const referenceIds: number[] = [];

function requireBookingId(): number {
  if (bookingId === undefined) {
    throw new Error("Test setup did not complete: booking id is missing");
  }
  return bookingId;
}

function requireOtherBookingId(): number {
  if (otherBookingId === undefined) {
    throw new Error("Test setup did not complete: second booking id is missing");
  }
  return otherBookingId;
}

async function createReference(data: {
  type: string;
  uid: string;
  deleted: boolean | null;
  externalCalendarId: string | null;
}): Promise<number> {
  const reference = await prisma.bookingReference.create({
    data: { ...data, bookingId: requireBookingId() },
    select: { id: true },
  });
  referenceIds.push(reference.id);
  return reference.id;
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  const calendarId = `calendar-${runId}@example.com`;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `notetaker-refs-it-${runId}@example.com`,
        username: `notetaker-refs-it-${runId}`,
      },
      select: { id: true },
    });
    userId = user.id;

    const startTime = new Date("2030-03-01T10:00:00.000Z");
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

    const booking = await prisma.booking.create({
      data: {
        uid: `notetaker-refs-it-${runId}-1`,
        title: "Notetaker references integration test",
        startTime,
        endTime,
        userId: user.id,
      },
      select: { id: true },
    });
    bookingId = booking.id;

    const otherBooking = await prisma.booking.create({
      data: {
        uid: `notetaker-refs-it-${runId}-2`,
        title: "Notetaker references integration test",
        startTime,
        endTime,
        userId: user.id,
      },
      select: { id: true },
    });
    otherBookingId = otherBooking.id;

    await createReference({
      type: "google_calendar",
      uid: `refs-it-${runId}-live`,
      deleted: false,
      externalCalendarId: calendarId,
    });
    await createReference({
      type: "google_calendar",
      uid: `refs-it-${runId}-deleted`,
      deleted: true,
      externalCalendarId: null,
    });
    await createReference({
      type: "google_calendar",
      uid: `refs-it-${runId}-null`,
      deleted: null,
      externalCalendarId: null,
    });
    await createReference({
      type: "google_meet_video",
      uid: `refs-it-${runId}-meet`,
      deleted: false,
      externalCalendarId: null,
    });
  });

  afterAll(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    if (referenceIds.length > 0) {
      await prisma.bookingReference.deleteMany({ where: { id: { in: referenceIds } } });
    }
    referenceIds.length = 0;
    if (bookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    }
    bookingId = undefined;
    if (otherBookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: otherBookingId } });
    }
    otherBookingId = undefined;
    if (userId !== undefined) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    userId = undefined;
  });

  it("returns only the live references of the type, in id order, with the five fields", async () => {
    const references = await repository.findReferencesByBookingIdAndType({
      bookingId: requireBookingId(),
      type: "google_calendar",
    });

    expect(references).toStrictEqual([
      {
        type: "google_calendar",
        uid: `refs-it-${runId}-live`,
        externalCalendarId: calendarId,
        credentialId: null,
        delegationCredentialId: null,
      },
      {
        type: "google_calendar",
        uid: `refs-it-${runId}-null`,
        externalCalendarId: null,
        credentialId: null,
        delegationCredentialId: null,
      },
    ]);
  });

  it("returns [] for another booking", async () => {
    const references = await repository.findReferencesByBookingIdAndType({
      bookingId: requireOtherBookingId(),
      type: "google_calendar",
    });

    expect(references).toStrictEqual([]);
  });
});
