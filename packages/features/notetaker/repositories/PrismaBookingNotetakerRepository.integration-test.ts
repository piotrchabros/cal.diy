import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import { PrismaBookingNotetakerRepository } from "./PrismaBookingNotetakerRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaBookingNotetakerRepository (integration)";
const SHARING_SUITE = "PrismaBookingNotetakerRepository sharing (integration)";

const SEEDED_AT = new Date("2029-12-01T00:00:00.000Z");
const ENABLED_AT = new Date("2029-12-02T00:00:00.000Z");
const CONCURRENT_CALLS = 5;
// Ids are autoincrement and positive, so -1 never matches a real user.
const UNKNOWN_USER_ID = -1;

const repository = new PrismaBookingNotetakerRepository(prisma);

let userId: number | undefined;
let bookingId: number | undefined;
let olderSubscriptionId: number | undefined;
let newerSubscriptionId: number | undefined;
let bookingCounter = 0;
const seriesBookingIds: number[] = [];
let verifiedEmailsUserId: number | undefined;
const secondaryEmailIds: number[] = [];

function requireBookingId(): number {
  if (bookingId === undefined) {
    throw new Error("Test setup did not complete: booking id is missing");
  }
  return bookingId;
}

function requireUserId(): number {
  if (userId === undefined) {
    throw new Error("Test setup did not complete: user id is missing");
  }
  return userId;
}

function subscriptionJson(label: string): string {
  return JSON.stringify({
    endpoint: `https://push.example.test/${runId}/${label}`,
    keys: { auth: "auth", p256dh: "p256dh" },
  });
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

async function createSeries() {
  const recurringEventId = `notetaker-choice-it-series-${runId}-${bookingCounter}`;
  const starts = ["2030-02-01T10:00:00.000Z", "2030-02-08T10:00:00.000Z", "2030-02-15T10:00:00.000Z"];
  const statuses = ["ACCEPTED", "CANCELLED", "ACCEPTED"] as const;
  const occurrences: { id: number; uid: string; startTime: Date; endTime: Date }[] = [];

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined) continue;
    const startTime = new Date(start);
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    const booking = await prisma.booking.create({
      data: {
        uid: `notetaker-choice-it-${runId}-${bookingCounter}-series-${index + 1}`,
        title: "Notetaker choice integration test",
        startTime,
        endTime,
        userId: requireUserId(),
        recurringEventId,
        status: statuses[index],
      },
      select: { id: true, uid: true },
    });
    seriesBookingIds.push(booking.id);
    occurrences.push({ id: booking.id, uid: booking.uid, startTime, endTime });
  }

  return { recurringEventId, occurrences };
}

function countTrue(results: boolean[]): number {
  return results.filter((result) => result).length;
}

function enableConcurrently(id: number): Promise<boolean[]> {
  return Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, () => repository.enableIfDisabled(enableInput(id, ENABLED_AT)))
  );
}

function disableConcurrently(id: number): Promise<boolean[]> {
  return Promise.all(Array.from({ length: CONCURRENT_CALLS }, () => repository.disableIfEnabled(id)));
}

function readGrant(id: number) {
  return prisma.notetakerSharingGrant.findUnique({
    where: { bookingId: id },
    select: { bookingId: true, grantedByUserId: true, grantedAt: true },
  });
}

function shareConcurrently(id: number, grantedByUserIds: (number | null)[]): Promise<boolean[]> {
  return Promise.all(
    grantedByUserIds.map((grantedByUserId) =>
      repository.createSharingGrantIfMissing({ bookingId: id, grantedByUserId })
    )
  );
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
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
    if (olderSubscriptionId !== undefined) {
      await prisma.notificationsSubscriptions.deleteMany({ where: { id: olderSubscriptionId } });
    }
    olderSubscriptionId = undefined;
    if (newerSubscriptionId !== undefined) {
      await prisma.notificationsSubscriptions.deleteMany({ where: { id: newerSubscriptionId } });
    }
    newerSubscriptionId = undefined;
    if (secondaryEmailIds.length > 0) {
      await prisma.secondaryEmail.deleteMany({ where: { id: { in: secondaryEmailIds } } });
    }
    secondaryEmailIds.length = 0;
    if (verifiedEmailsUserId !== undefined) {
      await prisma.user.deleteMany({ where: { id: verifiedEmailsUserId } });
    }
    verifiedEmailsUserId = undefined;
    // Deleting the booking cascades to its BookingNotetaker and Attendee rows.
    if (seriesBookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: seriesBookingIds } } });
    }
    seriesBookingIds.length = 0;
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

  describe("disableIfEnabled", () => {
    it("turns an enabled row off exactly once when five calls race", async () => {
      const id = requireBookingId();
      const notifiedAttendeeEmails = [`a-${runId}@example.com`];
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: true,
          pendingDispatch: true,
          rejoinBlocked: true,
          source: "HOST",
          setAt: SEEDED_AT,
          setByUserId: requireUserId(),
          notifiedAttendeeEmails,
          attendeesNotifiedAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });

      const results = await disableConcurrently(id);

      expect(countTrue(results)).toBe(1);
      expect(await readChoice(id)).toEqual({
        enabled: false,
        pendingDispatch: false,
        rejoinBlocked: true,
        setAt: SEEDED_AT,
        setByUserId: userId,
        source: "HOST",
        notifiedAttendeeEmails,
        attendeesNotifiedAt: SEEDED_AT,
      });
    });

    it("writes nothing when the row is already disabled", async () => {
      const id = requireBookingId();
      // The armed flag on a disabled row proves the update is filtered on `enabled: true`.
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: false,
          pendingDispatch: true,
          source: "HOST",
          setAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });

      const changed = await repository.disableIfEnabled(id);

      expect(changed).toBe(false);
      const choice = await readChoice(id);
      expect(choice?.enabled).toBe(false);
      expect(choice?.pendingDispatch).toBe(true);
      expect(choice?.setAt).toEqual(SEEDED_AT);
    });

    it("resolves false and creates no row when the booking has no choice", async () => {
      const id = requireBookingId();

      const changed = await repository.disableIfEnabled(id);

      expect(changed).toBe(false);
      expect(await prisma.bookingNotetaker.count({ where: { bookingId: id } })).toBe(0);
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

  describe("findWebPushSubscriptionsByUserIds", () => {
    it("returns only the most recent subscription of a user", async () => {
      const uid = requireUserId();
      const older = await prisma.notificationsSubscriptions.create({
        data: { userId: uid, subscription: subscriptionJson("older") },
        select: { id: true },
      });
      olderSubscriptionId = older.id;
      const newer = await prisma.notificationsSubscriptions.create({
        data: { userId: uid, subscription: subscriptionJson("newer") },
        select: { id: true },
      });
      newerSubscriptionId = newer.id;
      expect(newer.id).toBeGreaterThan(older.id);

      const result = await repository.findWebPushSubscriptionsByUserIds([uid, UNKNOWN_USER_ID]);

      expect(result).toEqual([{ userId: uid, subscription: subscriptionJson("newer") }]);
    });

    it("returns one record when the user is listed twice", async () => {
      const uid = requireUserId();
      const created = await prisma.notificationsSubscriptions.create({
        data: { userId: uid, subscription: subscriptionJson("only") },
        select: { id: true },
      });
      olderSubscriptionId = created.id;

      const result = await repository.findWebPushSubscriptionsByUserIds([uid, uid]);

      expect(result).toEqual([{ userId: uid, subscription: subscriptionJson("only") }]);
    });

    it("returns nothing for users without a subscription", async () => {
      const result = await repository.findWebPushSubscriptionsByUserIds([requireUserId(), UNKNOWN_USER_ID]);

      expect(result).toEqual([]);
    });

    it("returns an empty list for an empty input", async () => {
      expect(await repository.findWebPushSubscriptionsByUserIds([])).toEqual([]);
    });
  });

  describe("findByRecurringEventIdFromStartTime", () => {
    it("returns every occurrence with its status and end time in start order", async () => {
      const { recurringEventId, occurrences } = await createSeries();
      const [first, second, third] = occurrences;
      if (!first || !second || !third) throw new Error("Series setup did not create three bookings");
      await prisma.bookingNotetaker.create({
        data: { bookingId: first.id, enabled: true, source: "HOST", setAt: SEEDED_AT },
        select: { bookingId: true },
      });

      const rows = await repository.findByRecurringEventIdFromStartTime({
        recurringEventId,
        startTimeGte: first.startTime,
      });

      expect(rows).toEqual([
        {
          bookingId: first.id,
          bookingUid: first.uid,
          startTime: first.startTime,
          endTime: first.endTime,
          status: "ACCEPTED",
          choice: expect.objectContaining({ bookingId: first.id, enabled: true }),
        },
        {
          bookingId: second.id,
          bookingUid: second.uid,
          startTime: second.startTime,
          endTime: second.endTime,
          status: "CANCELLED",
          choice: null,
        },
        {
          bookingId: third.id,
          bookingUid: third.uid,
          startTime: third.startTime,
          endTime: third.endTime,
          status: "ACCEPTED",
          choice: null,
        },
      ]);
    });

    it("respects startTimeGte", async () => {
      const { recurringEventId, occurrences } = await createSeries();
      const [, second, third] = occurrences;
      if (!second || !third) throw new Error("Series setup did not create three bookings");

      const fromSecond = await repository.findByRecurringEventIdFromStartTime({
        recurringEventId,
        startTimeGte: second.startTime,
      });
      const afterThird = await repository.findByRecurringEventIdFromStartTime({
        recurringEventId,
        startTimeGte: new Date(third.startTime.getTime() + 1),
      });

      expect(fromSecond.map((row) => row.bookingId)).toEqual([second.id, third.id]);
      expect(afterThird).toEqual([]);
    });
  });

  describe("setAppliedToSeries", () => {
    it("changes only appliedToSeries", async () => {
      const id = requireBookingId();
      await prisma.bookingNotetaker.create({
        data: {
          bookingId: id,
          enabled: true,
          pendingDispatch: true,
          rejoinBlocked: true,
          source: "EVENT_TYPE_DEFAULT",
          setAt: SEEDED_AT,
          setByUserId: requireUserId(),
          notifiedAttendeeEmails: [`a-${runId}@example.com`],
          attendeesNotifiedAt: SEEDED_AT,
        },
        select: { bookingId: true },
      });
      const before = await repository.findByBookingId(id);

      await repository.setAppliedToSeries(id, true);
      expect(await repository.findByBookingId(id)).toEqual({ ...before, appliedToSeries: true });

      await repository.setAppliedToSeries(id, false);
      expect(await repository.findByBookingId(id)).toEqual(before);
    });

    it("creates nothing when the booking has no choice", async () => {
      const id = requireBookingId();

      await expect(repository.setAppliedToSeries(id, true)).resolves.toBeUndefined();

      expect(await prisma.bookingNotetaker.count({ where: { bookingId: id } })).toBe(0);
    });
  });

  describe("createSharingGrantIfMissing", () => {
    it("inserts the grant exactly once when five calls race", async () => {
      const id = requireBookingId();
      const uid = requireUserId();
      const grantedByUserIds = [uid, null, uid, null, uid];
      expect(grantedByUserIds).toHaveLength(CONCURRENT_CALLS);

      const results = await shareConcurrently(id, grantedByUserIds);

      expect(countTrue(results)).toBe(1);
      expect(await prisma.notetakerSharingGrant.count({ where: { bookingId: id } })).toBe(1);
      const grant = await readGrant(id);
      expect(grantedByUserIds).toContain(grant?.grantedByUserId);
    });

    it("resolves false and writes nothing when the grant already exists", async () => {
      const id = requireBookingId();
      const uid = requireUserId();

      expect(await repository.createSharingGrantIfMissing({ bookingId: id, grantedByUserId: uid })).toBe(
        true
      );
      const first = await readGrant(id);

      expect(await repository.createSharingGrantIfMissing({ bookingId: id, grantedByUserId: null })).toBe(
        false
      );

      expect(await readGrant(id)).toEqual(first);
      expect(first?.grantedByUserId).toBe(uid);
    });

    it("inserts again after the grant was deleted", async () => {
      const id = requireBookingId();
      const uid = requireUserId();
      await repository.createSharingGrantIfMissing({ bookingId: id, grantedByUserId: uid });
      await repository.deleteSharingGrant(id);

      expect(await repository.createSharingGrantIfMissing({ bookingId: id, grantedByUserId: uid })).toBe(
        true
      );

      expect(await prisma.notetakerSharingGrant.count({ where: { bookingId: id } })).toBe(1);
    });

    it("resolves false instead of throwing when createSharingGrant made the row", async () => {
      const id = requireBookingId();
      await repository.createSharingGrant({ bookingId: id, grantedByUserId: requireUserId() });

      await expect(
        repository.createSharingGrantIfMissing({ bookingId: id, grantedByUserId: null })
      ).resolves.toBe(false);

      expect(await prisma.notetakerSharingGrant.count({ where: { bookingId: id } })).toBe(1);
    });
  });

  describe("deleteSharingGrant", () => {
    it("removes the grant exactly once when two calls race", async () => {
      const id = requireBookingId();
      await prisma.notetakerSharingGrant.create({
        data: { bookingId: id, grantedByUserId: requireUserId() },
        select: { bookingId: true },
      });

      const results = await Promise.all(Array.from({ length: 2 }, () => repository.deleteSharingGrant(id)));

      expect(countTrue(results)).toBe(1);
      expect(await prisma.notetakerSharingGrant.count({ where: { bookingId: id } })).toBe(0);
    });

    it("resolves false when there is no grant", async () => {
      const id = requireBookingId();

      expect(await repository.deleteSharingGrant(id)).toBe(false);
    });
  });

  describe("findVerifiedEmailsByUserId", () => {
    it("returns the primary email only once the user is verified, and only verified secondary emails", async () => {
      const primaryEmail = `notetaker-choice-it-verified-${runId}@example.com`;
      const verifiedSecondary = `notetaker-choice-it-sec-verified-${runId}@example.com`;
      const unverifiedSecondary = `notetaker-choice-it-sec-unverified-${runId}@example.com`;
      const user = await prisma.user.create({
        data: { email: primaryEmail, username: primaryEmail, emailVerified: null },
        select: { id: true },
      });
      verifiedEmailsUserId = user.id;
      const verified = await prisma.secondaryEmail.create({
        data: {
          userId: user.id,
          email: verifiedSecondary,
          emailVerified: new Date("2029-11-01T00:00:00.000Z"),
        },
        select: { id: true },
      });
      secondaryEmailIds.push(verified.id);
      const unverified = await prisma.secondaryEmail.create({
        data: { userId: user.id, email: unverifiedSecondary, emailVerified: null },
        select: { id: true },
      });
      secondaryEmailIds.push(unverified.id);

      expect(await repository.findVerifiedEmailsByUserId(user.id)).toEqual([verifiedSecondary]);

      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date("2029-11-02T00:00:00.000Z") },
        select: { id: true },
      });

      expect(await repository.findVerifiedEmailsByUserId(user.id)).toEqual([primaryEmail, verifiedSecondary]);
    });

    it("returns an empty list for an unknown user", async () => {
      expect(await repository.findVerifiedEmailsByUserId(UNKNOWN_USER_ID)).toEqual([]);
    });
  });
});

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SHARING_SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SHARING_SUITE, () => {
  const prefix = "notetaker-sharing-it-";
  const ORGANIZER_NAME = `Sharing Organizer ${runId}`;

  let organizerId: number | undefined;
  let otherOrganizerId: number | undefined;
  let organizationId: number | undefined;
  let subTeamId: number | undefined;
  let standaloneTeamId: number | undefined;
  let subTeamEventTypeId: number | undefined;
  let standaloneEventTypeId: number | undefined;
  let otherEventTypeId: number | undefined;
  let personalEventTypeId: number | undefined;
  let uidCounter = 0;
  const bookingIds: number[] = [];

  function required(value: number | undefined, label: string): number {
    if (value === undefined) {
      throw new Error(`Test setup did not complete: ${label} is missing`);
    }
    return value;
  }

  function ownEventTypeIds(): number[] {
    return [subTeamEventTypeId, standaloneEventTypeId, otherEventTypeId, personalEventTypeId].filter(
      (id): id is number => id !== undefined
    );
  }

  async function createTeam(
    slug: string,
    name: string,
    extra: { isOrganization?: boolean; parentId?: number }
  ) {
    const team = await prisma.team.create({
      data: { name, slug: `${prefix}${runId}-${slug}`, ...extra },
      select: { id: true },
    });
    return team.id;
  }

  async function createEventType(slug: string, extra: { teamId?: number; userId?: number }) {
    const eventType = await prisma.eventType.create({
      data: { title: `Sharing ${slug}`, slug: `${prefix}${runId}-${slug}`, length: 30, ...extra },
      select: { id: true },
    });
    return eventType.id;
  }

  async function createBooking(params: { eventTypeId: number | null; startTime: Date }): Promise<number> {
    uidCounter += 1;
    const booking = await prisma.booking.create({
      data: {
        uid: `${prefix}${runId}-${uidCounter}`,
        title: "Notetaker sharing integration test",
        startTime: params.startTime,
        endTime: new Date(params.startTime.getTime() + 30 * 60 * 1000),
        userId: required(organizerId, "organizer id"),
        eventTypeId: params.eventTypeId,
      },
      select: { id: true },
    });
    bookingIds.push(booking.id);
    return booking.id;
  }

  async function createSession(params: {
    bookingId: number;
    startTime: Date;
    disclosed: boolean;
    withTranscript: boolean;
    dispatchedAt?: Date;
    resultsDeletedAt?: Date;
    summaryStatus?: "PENDING" | "READY";
  }): Promise<string> {
    const session = await prisma.notetakerSession.create({
      data: {
        bookingId: params.bookingId,
        platform: "GOOGLE_MEET",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        botProvider: "FAKE",
        displayName: "Notetaker",
        scheduledStartAt: params.startTime,
        dispatchedAt: params.dispatchedAt,
        colleagueSharingDisclosed: params.disclosed,
        resultsDeletedAt: params.resultsDeletedAt,
      },
      select: { id: true },
    });
    if (params.withTranscript) {
      const transcript = await prisma.notetakerTranscript.create({
        data: { sessionId: session.id, bookingId: params.bookingId },
        select: { id: true },
      });
      if (params.summaryStatus !== undefined) {
        await prisma.notetakerSummary.create({
          data: { transcriptId: transcript.id, status: params.summaryStatus },
          select: { id: true },
        });
      }
    }
    return session.id;
  }

  // A booking with one session, the usual shape of a listed result.
  async function createBookingWithSession(params: {
    eventTypeId: number | null;
    startTime: Date;
    disclosed: boolean;
    withTranscript: boolean;
    dispatchedAt?: Date;
    resultsDeletedAt?: Date;
    summaryStatus?: "PENDING" | "READY";
  }): Promise<number> {
    const id = await createBooking({ eventTypeId: params.eventTypeId, startTime: params.startTime });
    await createSession({ ...params, bookingId: id });
    return id;
  }

  function setSharingMode(eventTypeId: number, sharingMode: "TEAM" | "SELECTED_PEOPLE" | "HOSTS_ONLY") {
    return prisma.eventTypeNotetakerSettings.create({
      data: { eventTypeId, sharingMode },
      select: { eventTypeId: true },
    });
  }

  beforeAll(async () => {
    const organizer = await prisma.user.create({
      data: {
        email: `${prefix}${runId}-organizer@example.com`,
        username: `${prefix}${runId}-organizer`,
        name: ORGANIZER_NAME,
      },
      select: { id: true },
    });
    organizerId = organizer.id;
    const otherOrganizer = await prisma.user.create({
      data: {
        email: `${prefix}${runId}-other@example.com`,
        username: `${prefix}${runId}-other`,
      },
      select: { id: true },
    });
    otherOrganizerId = otherOrganizer.id;

    organizationId = await createTeam("org", `Sharing Org ${runId}`, { isOrganization: true });
    subTeamId = await createTeam("sub", `Sharing Sub ${runId}`, { parentId: organizationId });
    standaloneTeamId = await createTeam("standalone", `Sharing Standalone ${runId}`, {});

    subTeamEventTypeId = await createEventType("sub", { teamId: subTeamId });
    standaloneEventTypeId = await createEventType("standalone", { teamId: standaloneTeamId });
    otherEventTypeId = await createEventType("other", { teamId: standaloneTeamId });
    personalEventTypeId = await createEventType("personal", { userId: organizer.id });
  });

  afterEach(async () => {
    // Prisma treats `where: { id: undefined }` as no filter, so every delete needs an explicit guard
    // to avoid wiping a real database when setup failed before the id was assigned.
    const eventTypeIds = ownEventTypeIds();
    if (eventTypeIds.length > 0) {
      await prisma.eventTypeNotetakerSettings.deleteMany({ where: { eventTypeId: { in: eventTypeIds } } });
    }
    // Deleting the booking cascades to its sessions, transcripts, summaries and attendees.
    if (bookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    bookingIds.length = 0;
  });

  afterAll(async () => {
    const eventTypeIds = ownEventTypeIds();
    if (eventTypeIds.length > 0) {
      await prisma.eventType.deleteMany({ where: { id: { in: eventTypeIds } } });
    }
    if (subTeamId !== undefined) {
      await prisma.team.deleteMany({ where: { id: subTeamId } });
    }
    if (standaloneTeamId !== undefined) {
      await prisma.team.deleteMany({ where: { id: standaloneTeamId } });
    }
    if (organizationId !== undefined) {
      await prisma.team.deleteMany({ where: { id: organizationId } });
    }
    const userIds = [organizerId, otherOrganizerId].filter((id): id is number => id !== undefined);
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  describe("booking context", () => {
    const startTime = new Date("2030-04-01T10:00:00.000Z");

    it("reports the team, the organization and the stored sharing mode of a sub-team event type", async () => {
      await setSharingMode(required(subTeamEventTypeId, "sub-team event type id"), "TEAM");
      const id = await createBooking({ eventTypeId: required(subTeamEventTypeId, "event type"), startTime });

      const context = await repository.findByBookingIdIncludeBooking(id);

      expect(context).toEqual(
        expect.objectContaining({
          teamId: subTeamId,
          teamName: `Sharing Sub ${runId}`,
          organizationId,
          sharingMode: "TEAM",
        })
      );
    });

    it("defaults to HOSTS_ONLY for a team event type without a settings row", async () => {
      const id = await createBooking({
        eventTypeId: required(standaloneEventTypeId, "event type"),
        startTime,
      });

      const context = await repository.findByBookingIdIncludeBooking(id);

      expect(context?.sharingMode).toBe("HOSTS_ONLY");
      expect(context?.teamId).toBe(standaloneTeamId);
      expect(context?.organizationId).toBeNull();
    });

    it("reports SELECTED_PEOPLE when the settings row says so", async () => {
      await setSharingMode(required(standaloneEventTypeId, "event type"), "SELECTED_PEOPLE");
      const id = await createBooking({
        eventTypeId: required(standaloneEventTypeId, "event type"),
        startTime,
      });

      const context = await repository.findByBookingIdIncludeBooking(id);

      expect(context?.sharingMode).toBe("SELECTED_PEOPLE");
    });

    it("reports no team and HOSTS_ONLY for a personal event type", async () => {
      const id = await createBooking({ eventTypeId: required(personalEventTypeId, "event type"), startTime });

      const context = await repository.findByBookingIdIncludeBooking(id);

      expect(context).toEqual(
        expect.objectContaining({
          teamId: null,
          teamName: null,
          organizationId: null,
          sharingMode: "HOSTS_ONLY",
        })
      );
    });

    it("reports no team and HOSTS_ONLY for a booking without an event type", async () => {
      const id = await createBooking({ eventTypeId: null, startTime });

      const context = await repository.findByBookingIdIncludeBooking(id);

      expect(context).toEqual(
        expect.objectContaining({
          teamId: null,
          teamName: null,
          organizationId: null,
          sharingMode: "HOSTS_ONLY",
        })
      );
    });

    it("returns the same four fields when the booking is looked up by uid", async () => {
      await setSharingMode(required(subTeamEventTypeId, "sub-team event type id"), "TEAM");
      const id = await createBooking({ eventTypeId: required(subTeamEventTypeId, "event type"), startTime });
      const byId = await repository.findByBookingIdIncludeBooking(id);
      if (!byId) throw new Error("Booking context was not found by id");

      const byUid = await repository.findByBookingUidIncludeBooking(byId.uid);

      expect(byUid).toEqual(
        expect.objectContaining({
          teamId: byId.teamId,
          teamName: byId.teamName,
          organizationId: byId.organizationId,
          sharingMode: byId.sharingMode,
        })
      );
      expect(byUid?.sharingMode).toBe("TEAM");
    });
  });

  describe("findByEventTypeIdsIncludeResultsSession", () => {
    const early = new Date("2030-05-01T10:00:00.000Z");
    const middle = new Date("2030-05-02T10:00:00.000Z");
    const late = new Date("2030-05-03T10:00:00.000Z");

    // Four listed bookings, two of them at the same start time, newest first with ties broken by id.
    async function createListedBookings(): Promise<number[]> {
      const eventTypeId = required(standaloneEventTypeId, "event type");
      const ids: number[] = [];
      for (const startTime of [early, middle, middle, late]) {
        ids.push(
          await createBookingWithSession({ eventTypeId, startTime, disclosed: true, withTranscript: true })
        );
      }
      const [first, secondMiddle, thirdMiddle, last] = ids;
      if (
        first === undefined ||
        secondMiddle === undefined ||
        thirdMiddle === undefined ||
        last === undefined
      ) {
        throw new Error("Listed bookings were not created");
      }
      return [last, Math.max(secondMiddle, thirdMiddle), Math.min(secondMiddle, thirdMiddle), first];
    }

    it("returns an empty list for no event types", async () => {
      expect(
        await repository.findByEventTypeIdsIncludeResultsSession({
          eventTypeIds: [],
          cursor: null,
          limit: 10,
        })
      ).toEqual([]);
    });

    it("lists only bookings with a disclosed session that has a transcript, of the asked event types", async () => {
      const standaloneId = required(standaloneEventTypeId, "event type");
      const otherId = required(otherEventTypeId, "other event type");
      const listed = await createBookingWithSession({
        eventTypeId: standaloneId,
        startTime: early,
        disclosed: true,
        withTranscript: true,
      });
      await createBookingWithSession({
        eventTypeId: standaloneId,
        startTime: middle,
        disclosed: true,
        withTranscript: false,
      });
      await createBookingWithSession({
        eventTypeId: standaloneId,
        startTime: late,
        disclosed: false,
        withTranscript: true,
      });
      const ofOtherEventType = await createBookingWithSession({
        eventTypeId: otherId,
        startTime: early,
        disclosed: true,
        withTranscript: true,
      });

      const onlyStandalone = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [standaloneId],
        cursor: null,
        limit: 10,
      });
      const both = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [standaloneId, otherId],
        cursor: null,
        limit: 10,
      });

      expect(onlyStandalone.map((row) => row.bookingId)).toEqual([listed]);
      expect(both.map((row) => row.bookingId).sort((a, b) => a - b)).toEqual(
        [listed, ofOtherEventType].sort((a, b) => a - b)
      );
    });

    it("orders by start time then id, both descending, and honours the limit", async () => {
      const expected = await createListedBookings();
      const eventTypeIds = [required(standaloneEventTypeId, "event type")];

      const all = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds,
        cursor: null,
        limit: 10,
      });
      const limited = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds,
        cursor: null,
        limit: 3,
      });

      expect(all.map((row) => row.bookingId)).toEqual(expected);
      expect(limited.map((row) => row.bookingId)).toEqual(expected.slice(0, 3));
    });

    it("pages with a cursor without overlap or gap, including a row that shares the cursor start time", async () => {
      const expected = await createListedBookings();
      const eventTypeIds = [required(standaloneEventTypeId, "event type")];

      const pageOne = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds,
        cursor: null,
        limit: 2,
      });
      const lastOfPageOne = pageOne[pageOne.length - 1];
      if (!lastOfPageOne) throw new Error("The first page is empty");
      const pageTwo = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds,
        cursor: { startTime: lastOfPageOne.startTime, id: lastOfPageOne.bookingId },
        limit: 2,
      });

      expect(pageOne.map((row) => row.bookingId)).toEqual(expected.slice(0, 2));
      expect(pageTwo.map((row) => row.bookingId)).toEqual(expected.slice(2));
    });

    it("returns the booking fields, the attendees and the results session", async () => {
      const eventTypeId = required(standaloneEventTypeId, "event type");
      const withoutSummary = await createBookingWithSession({
        eventTypeId,
        startTime: early,
        disclosed: true,
        withTranscript: true,
      });
      const withSummary = await createBookingWithSession({
        eventTypeId,
        startTime: late,
        disclosed: true,
        withTranscript: true,
        summaryStatus: "READY",
      });
      for (const email of [`a-${runId}@example.com`, `b-${runId}@example.com`]) {
        await prisma.attendee.create({
          data: { bookingId: withoutSummary, email, name: "Attendee", timeZone: "UTC" },
          select: { id: true },
        });
      }

      const rows = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [eventTypeId],
        cursor: null,
        limit: 10,
      });

      const plain = rows.find((row) => row.bookingId === withoutSummary);
      const summarized = rows.find((row) => row.bookingId === withSummary);
      const stored = await prisma.booking.findUnique({
        where: { id: withoutSummary },
        select: { uid: true, title: true },
      });
      expect(plain).toEqual({
        bookingId: withoutSummary,
        bookingUid: stored?.uid,
        title: stored?.title,
        startTime: early,
        eventTypeId,
        organizerUserId: organizerId,
        organizerName: ORGANIZER_NAME,
        attendeeEmails: expect.arrayContaining([`a-${runId}@example.com`, `b-${runId}@example.com`]),
        resultsSession: {
          id: expect.any(String),
          colleagueSharingDisclosed: true,
          resultsDeletedAt: null,
          summaryStatus: null,
        },
      });
      expect(plain?.attendeeEmails).toHaveLength(2);
      expect(summarized?.resultsSession?.summaryStatus).toBe("READY");
    });

    it("returns resultsDeletedAt of the session", async () => {
      const deletedAt = new Date("2030-05-10T00:00:00.000Z");
      const id = await createBookingWithSession({
        eventTypeId: required(standaloneEventTypeId, "event type"),
        startTime: early,
        disclosed: true,
        withTranscript: true,
        resultsDeletedAt: deletedAt,
      });

      const rows = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [required(standaloneEventTypeId, "event type")],
        cursor: null,
        limit: 10,
      });

      expect(rows.find((row) => row.bookingId === id)?.resultsSession?.resultsDeletedAt).toEqual(deletedAt);
    });

    it("shows the newest session with a transcript even when only an older one is disclosed", async () => {
      const id = await createBooking({
        eventTypeId: required(standaloneEventTypeId, "event type"),
        startTime: early,
      });
      await createSession({
        bookingId: id,
        startTime: early,
        disclosed: true,
        withTranscript: true,
        dispatchedAt: new Date("2030-05-01T09:00:00.000Z"),
      });
      const newerSessionId = await createSession({
        bookingId: id,
        startTime: early,
        disclosed: false,
        withTranscript: true,
        dispatchedAt: new Date("2030-05-01T09:30:00.000Z"),
      });

      const rows = await repository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [required(standaloneEventTypeId, "event type")],
        cursor: null,
        limit: 10,
      });

      const row = rows.find((candidate) => candidate.bookingId === id);
      expect(row?.resultsSession?.id).toBe(newerSessionId);
      expect(row?.resultsSession?.colleagueSharingDisclosed).toBe(false);
    });
  });
});
