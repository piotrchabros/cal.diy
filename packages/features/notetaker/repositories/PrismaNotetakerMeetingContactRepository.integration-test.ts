import { prisma } from "@calcom/prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import { PrismaNotetakerMeetingContactRepository } from "./PrismaNotetakerMeetingContactRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaNotetakerMeetingContactRepository (integration)";

const repository = new PrismaNotetakerMeetingContactRepository(prisma);

let ownerId: number | undefined;
const bookingIds: number[] = [];

function requireId(id: number | undefined, label: string): number {
  if (id === undefined) {
    throw new Error(`Test setup did not complete: ${label} is missing`);
  }
  return id;
}

async function createBooking(suffix: string): Promise<number> {
  const startTime = new Date("2030-04-01T10:00:00.000Z");
  const booking = await prisma.booking.create({
    data: {
      uid: `notetaker-contact-it-${runId}-${suffix}`,
      title: "Notetaker meeting contact integration test",
      startTime,
      endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
      userId: requireId(ownerId, "owner id"),
    },
    select: { id: true },
  });
  bookingIds.push(booking.id);
  return booking.id;
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `notetaker-contact-it-${runId}@example.com`,
        username: `notetaker-contact-it-${runId}`,
      },
      select: { id: true },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    // Contact rows cascade with their booking.
    if (bookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    bookingIds.length = 0;
    if (ownerId !== undefined) {
      await prisma.user.deleteMany({ where: { id: ownerId } });
    }
    ownerId = undefined;
  });

  it("replaceForSource replaces only the given source", async () => {
    const bookingId = await createBooking("replace");
    await repository.replaceForSource({
      bookingId,
      source: "CALENDAR",
      contacts: [{ email: "cal@example.com", name: "Cal" }],
    });
    await repository.replaceForSource({
      bookingId,
      source: "MANUAL",
      contacts: [{ email: "old@example.com", name: null }],
    });
    await repository.replaceForSource({
      bookingId,
      source: "MANUAL",
      contacts: [{ email: "new@example.com", name: null }],
    });

    expect(await repository.listByBookingId(bookingId)).toEqual([
      { email: "cal@example.com", name: "Cal", source: "CALENDAR" },
      { email: "new@example.com", name: null, source: "MANUAL" },
    ]);
  });

  it("keeps the other source's row when an email is already stored there", async () => {
    const bookingId = await createBooking("shared");
    await repository.replaceForSource({
      bookingId,
      source: "CALENDAR",
      contacts: [{ email: "shared@example.com", name: "From calendar" }],
    });
    await repository.replaceForSource({
      bookingId,
      source: "MANUAL",
      contacts: [
        { email: "shared@example.com", name: null },
        { email: "manual@example.com", name: null },
        { email: "manual@example.com", name: null },
      ],
    });

    const contacts = await repository.listByBookingId(bookingId);
    expect(contacts).toHaveLength(2);
    expect(contacts).toEqual(
      expect.arrayContaining([
        { email: "shared@example.com", name: "From calendar", source: "CALENDAR" },
        { email: "manual@example.com", name: null, source: "MANUAL" },
      ])
    );
  });

  it("an empty list clears the source and leaves other bookings alone", async () => {
    const bookingId = await createBooking("clear");
    const otherBookingId = await createBooking("other");
    await repository.replaceForSource({
      bookingId,
      source: "MANUAL",
      contacts: [{ email: "manual@example.com", name: null }],
    });
    await repository.replaceForSource({
      bookingId: otherBookingId,
      source: "MANUAL",
      contacts: [{ email: "manual@example.com", name: null }],
    });

    await repository.replaceForSource({ bookingId, source: "MANUAL", contacts: [] });

    expect(await repository.listByBookingId(bookingId)).toEqual([]);
    expect(await repository.listByBookingId(otherBookingId)).toEqual([
      { email: "manual@example.com", name: null, source: "MANUAL" },
    ]);
  });

  it("contacts are deleted with their booking", async () => {
    const bookingId = await createBooking("cascade");
    await repository.replaceForSource({
      bookingId,
      source: "CALENDAR",
      contacts: [{ email: "cal@example.com", name: null }],
    });

    await prisma.booking.deleteMany({ where: { id: bookingId } });

    expect(await prisma.notetakerMeetingContact.count({ where: { bookingId } })).toBe(0);
  });
});
