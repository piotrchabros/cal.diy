import { prisma } from "@calcom/prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import { PrismaNotetakerActivityRepository } from "./PrismaNotetakerActivityRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaNotetakerActivityRepository (integration)";

const repository = new PrismaNotetakerActivityRepository(prisma);

let viewerId: number | undefined;
let otherViewerId: number | undefined;
let bookingId: number | undefined;
let otherBookingId: number | undefined;

function requireId(id: number | undefined, label: string): number {
  if (id === undefined) {
    throw new Error(`Test setup did not complete: ${label} is missing`);
  }
  return id;
}

async function createUser(suffix: string): Promise<number> {
  const user = await prisma.user.create({
    data: {
      email: `notetaker-activity-it-${runId}-${suffix}@example.com`,
      username: `notetaker-activity-it-${runId}-${suffix}`,
    },
    select: { id: true },
  });
  return user.id;
}

async function createBooking(suffix: string, userId: number): Promise<number> {
  const startTime = new Date("2030-04-01T10:00:00.000Z");
  const booking = await prisma.booking.create({
    data: {
      uid: `notetaker-activity-it-${runId}-${suffix}`,
      title: "Notetaker activity integration test",
      startTime,
      endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
      userId,
    },
    select: { id: true },
  });
  return booking.id;
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  beforeAll(async () => {
    viewerId = await createUser("viewer");
    otherViewerId = await createUser("other");
    bookingId = await createBooking("1", viewerId);
    otherBookingId = await createBooking("2", viewerId);
  });

  afterAll(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    // Activity rows cascade with their booking.
    if (bookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: bookingId } });
    }
    bookingId = undefined;
    if (otherBookingId !== undefined) {
      await prisma.booking.deleteMany({ where: { id: otherBookingId } });
    }
    otherBookingId = undefined;
    if (viewerId !== undefined) {
      await prisma.user.deleteMany({ where: { id: viewerId } });
    }
    viewerId = undefined;
    if (otherViewerId !== undefined) {
      await prisma.user.deleteMany({ where: { id: otherViewerId } });
    }
    otherViewerId = undefined;
  });

  async function record(params: {
    bookingId: number;
    action: "SHARED_VIEWED" | "EXPORTED";
    actorUserId: number | null;
  }): Promise<void> {
    await repository.create({
      bookingId: params.bookingId,
      sessionId: null,
      action: params.action,
      actorType: "USER",
      actorUserId: params.actorUserId,
      actorName: null,
      detail: null,
    });
  }

  it("existsByBookingIdAndActionAndActorUserId is false when the booking has no activity", async () => {
    const exists = await repository.existsByBookingIdAndActionAndActorUserId({
      bookingId: requireId(bookingId, "booking id"),
      action: "SHARED_VIEWED",
      actorUserId: requireId(viewerId, "viewer id"),
    });

    expect(exists).toBe(false);
  });

  describe("with a SHARED_VIEWED row by the viewer on the first booking", () => {
    beforeAll(async () => {
      await record({
        bookingId: requireId(bookingId, "booking id"),
        action: "SHARED_VIEWED",
        actorUserId: requireId(viewerId, "viewer id"),
      });
    });

    it("is true for that booking, action and user", async () => {
      const exists = await repository.existsByBookingIdAndActionAndActorUserId({
        bookingId: requireId(bookingId, "booking id"),
        action: "SHARED_VIEWED",
        actorUserId: requireId(viewerId, "viewer id"),
      });

      expect(exists).toBe(true);
    });

    it("is false for another user on the same booking and action", async () => {
      const exists = await repository.existsByBookingIdAndActionAndActorUserId({
        bookingId: requireId(bookingId, "booking id"),
        action: "SHARED_VIEWED",
        actorUserId: requireId(otherViewerId, "other viewer id"),
      });

      expect(exists).toBe(false);
    });

    it("is false for the same user and booking with another action", async () => {
      const exists = await repository.existsByBookingIdAndActionAndActorUserId({
        bookingId: requireId(bookingId, "booking id"),
        action: "EXPORTED",
        actorUserId: requireId(viewerId, "viewer id"),
      });

      expect(exists).toBe(false);
    });

    it("is false for the same user and action on the other booking", async () => {
      const exists = await repository.existsByBookingIdAndActionAndActorUserId({
        bookingId: requireId(otherBookingId, "other booking id"),
        action: "SHARED_VIEWED",
        actorUserId: requireId(viewerId, "viewer id"),
      });

      expect(exists).toBe(false);
    });
  });

  it("a SHARED_VIEWED row without an actor does not make the check true for any user", async () => {
    const thirdBookingId = await createBooking("3", requireId(viewerId, "viewer id"));
    try {
      await record({ bookingId: thirdBookingId, action: "SHARED_VIEWED", actorUserId: null });

      const forViewer = await repository.existsByBookingIdAndActionAndActorUserId({
        bookingId: thirdBookingId,
        action: "SHARED_VIEWED",
        actorUserId: requireId(viewerId, "viewer id"),
      });
      const forOther = await repository.existsByBookingIdAndActionAndActorUserId({
        bookingId: thirdBookingId,
        action: "SHARED_VIEWED",
        actorUserId: requireId(otherViewerId, "other viewer id"),
      });

      expect(forViewer).toBe(false);
      expect(forOther).toBe(false);
    } finally {
      await prisma.booking.deleteMany({ where: { id: thirdBookingId } });
    }
  });

  it("findDistinctActorUserIdsByBookingIdAndAction returns each viewer once", async () => {
    const fourthBookingId = await createBooking("4", requireId(viewerId, "viewer id"));
    const viewer = requireId(viewerId, "viewer id");
    const other = requireId(otherViewerId, "other viewer id");
    try {
      await record({ bookingId: fourthBookingId, action: "SHARED_VIEWED", actorUserId: viewer });
      await record({ bookingId: fourthBookingId, action: "SHARED_VIEWED", actorUserId: viewer });
      await record({ bookingId: fourthBookingId, action: "SHARED_VIEWED", actorUserId: other });
      await record({ bookingId: fourthBookingId, action: "SHARED_VIEWED", actorUserId: null });
      await record({ bookingId: fourthBookingId, action: "EXPORTED", actorUserId: other });

      const userIds = await repository.findDistinctActorUserIdsByBookingIdAndAction({
        bookingId: fourthBookingId,
        action: "SHARED_VIEWED",
      });

      expect([...userIds].sort((a, b) => a - b)).toEqual([viewer, other].sort((a, b) => a - b));
    } finally {
      await prisma.booking.deleteMany({ where: { id: fourthBookingId } });
    }
  });
});
