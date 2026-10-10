import process from "node:process";
import {
  sendNotetakerAttendeeNoticeEmail,
  sendNotetakerFailedEmail,
  sendNotetakerSharedEmail,
  sendNotetakerTurnedOffEmail,
} from "@calcom/emails/notetaker-email-service";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createNotetakerBotGatewayError } from "../bot/INotetakerBotGateway";
import { getNotetakerChoiceService } from "../di/NotetakerChoiceService.container";
import { getNotetakerResultsService } from "../di/NotetakerResultsService.container";
import { escapeMarkdown } from "../lib/exportMarkdown";
import type { QuickstartBooking, QuickstartHarness, QuickstartUser } from "./quickstartHarness";
import {
  createQuickstartHarness,
  isQuickstartIsolatedDatabase,
  QUICKSTART_SKIP_MESSAGE,
} from "./quickstartHarness";

// Inlined rather than calling applyQuickstartEnv: hoisted code runs before any import, and importing
// the harness here would load packages/lib/constants.ts before ENABLE_ASYNC_TASKER is set.
// globalThis.process because vi.hoisted runs above the imports, where an imported `process` is still uninitialised.
vi.hoisted(() => {
  if (globalThis.process.env.NODE_ENV === "production") {
    throw new Error("The notetaker quickstart walk-through must not run with NODE_ENV=production");
  }
  globalThis.process.env.ENABLE_ASYNC_TASKER = "false";
  globalThis.process.env.NOTETAKER_BOT_PROVIDER = "fake";
  globalThis.process.env.NOTETAKER_BOT_SECRET = "quickstart-it-secret";
  globalThis.process.env.ANTHROPIC_API_KEY = "";
  delete globalThis.process.env.NOTETAKER_FAKE_SCENARIO;
  delete globalThis.process.env.NOTETAKER_SUMMARY_MIN_WORDS;
  delete globalThis.process.env.NOTETAKER_JOIN_LEAD_SECONDS;
  delete globalThis.process.env.NOTETAKER_ENABLED_PLATFORMS;
});

vi.mock("@calcom/emails/notetaker-email-service", () => ({
  sendNotetakerResultsReadyEmail: vi.fn(),
  sendNotetakerAttendeeNoticeEmail: vi.fn(),
  sendNotetakerAdmitPromptEmail: vi.fn(),
  sendNotetakerFailedEmail: vi.fn(),
  sendNotetakerTurnedOffEmail: vi.fn(),
  sendNotetakerSharedEmail: vi.fn(),
}));
vi.mock("@calcom/features/notifications/sendNotification", () => ({ sendNotification: vi.fn() }));
vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(
    async (locale: string) => (key: string, vars?: Record<string, string>) =>
      `${locale}:${key}:${JSON.stringify(vars ?? {})}`
  ),
}));

// The default DATABASE_URL of this checkout is a live site's database, and this file runs the sweep,
// which acts on every armed booking it finds. It therefore runs only against the scratch database.
const RUNS_ON_ISOLATED_DATABASE = isQuickstartIsolatedDatabase();

const SUITE = "Notetaker quickstart: defaults, sharing and lifecycle (integration)";
const TWO_HOURS_MS = 2 * 60 * 60_000;
const MEET_EVENT_TYPE_LOCATIONS = [{ type: "integrations:google:meet" }];

function findSessions(bookingId: number) {
  return prisma.notetakerSession.findMany({
    where: { bookingId },
    select: { id: true, status: true, outcomeReason: true },
  });
}

function findChoice(bookingId: number) {
  return prisma.bookingNotetaker.findUnique({
    where: { bookingId },
    select: { enabled: true, pendingDispatch: true, source: true },
  });
}

function findActivities(bookingId: number) {
  return prisma.notetakerActivity.findMany({
    where: { bookingId },
    orderBy: { createdAt: "asc" },
    select: { action: true, actorType: true, detail: true },
  });
}

function noticeRecipients(): string[] {
  return vi.mocked(sendNotetakerAttendeeNoticeEmail).mock.calls.map(([input]) => input.to.email);
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  let harness: QuickstartHarness;
  let host: QuickstartUser;
  let attendee: QuickstartUser;
  let outsider: QuickstartUser;

  const choiceService = getNotetakerChoiceService();
  const resultsService = getNotetakerResultsService();

  function enable(booking: QuickstartBooking): Promise<void> {
    return choiceService.setEnabled({
      bookingUid: booking.uid,
      enabled: true,
      scope: "THIS_BOOKING",
      userId: host.id,
    });
  }

  async function createDefaultOnEventType(label: string): Promise<{ id: number }> {
    const eventType = await harness.createEventType({
      ownerId: host.id,
      label,
      locations: MEET_EVENT_TYPE_LOCATIONS,
    });
    await choiceService.setEventTypeDefault({
      eventTypeId: eventType.id,
      enabledByDefault: true,
      userId: host.id,
    });
    return eventType;
  }

  beforeAll(async () => {
    harness = await createQuickstartHarness("lifecycle");
    host = await harness.createUser({ label: "lc-host", notetakerFlag: true });
    attendee = await harness.createUser({ label: "lc-attendee", notetakerFlag: false });
    outsider = await harness.createUser({ label: "lc-outsider", notetakerFlag: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  describe("scenario 7: event-type default and disclosure", () => {
    it("the event-type default discloses and enables a new booking with source EVENT_TYPE_DEFAULT", async () => {
      const eventType = await harness.createEventType({
        ownerId: host.id,
        label: "lc-default-on",
        locations: MEET_EVENT_TYPE_LOCATIONS,
      });
      expect((await choiceService.getDisclosure({ eventTypeId: eventType.id })).enabledByDefault).toBe(false);

      const saved = await choiceService.setEventTypeDefault({
        eventTypeId: eventType.id,
        enabledByDefault: true,
        userId: host.id,
      });
      expect(saved).toEqual({ enabledByDefault: true, available: true, unavailableReason: null });
      expect(await choiceService.getDisclosure({ eventTypeId: eventType.id })).toEqual({
        enabledByDefault: true,
        onBehalfOf: host.name,
        sharedWithColleagues: false,
        supportedLocationTypes: ["integrations:google:meet"],
      });

      const booking = await harness.createBooking({
        hostId: host.id,
        label: "lc-default-on",
        eventTypeId: eventType.id,
        startsInMs: TWO_HOURS_MS,
        attendees: [{ email: attendee.email, name: attendee.name }],
      });
      await choiceService.onBookingCreated({ bookingUid: booking.uid });

      const state = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      expect(state.choice).toMatchObject({ enabled: true, source: "EVENT_TYPE_DEFAULT", setByName: null });
      expect(await findChoice(booking.id)).toEqual({
        enabled: true,
        pendingDispatch: true,
        source: "EVENT_TYPE_DEFAULT",
      });
      expect(await findActivities(booking.id)).toEqual([
        { action: "ENABLED", actorType: "SYSTEM", detail: { source: "EVENT_TYPE_DEFAULT" } },
      ]);
    });

    it("a guest attendee of an inherited booking gets the notice", async () => {
      const eventType = await createDefaultOnEventType("lc-guest");
      const guestEmail = `notetaker-qs-lc-guest-${harness.runId}@example.com`;
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "lc-guest",
        eventTypeId: eventType.id,
        startsInMs: TWO_HOURS_MS,
        attendees: [
          { email: attendee.email, name: attendee.name },
          { email: guestEmail, name: "Quickstart Guest" },
        ],
      });

      await choiceService.onBookingCreated({ bookingUid: booking.uid });

      expect(noticeRecipients().sort()).toEqual([attendee.email, guestEmail].sort());
      expect(sendNotetakerAttendeeNoticeEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: guestEmail, name: "Quickstart Guest" },
          hostName: host.name,
          isPending: false,
        })
      );

      // A replayed hook must not tell anyone twice.
      await choiceService.onBookingCreated({ bookingUid: booking.uid });
      expect(noticeRecipients()).toHaveLength(2);
    });

    it("turning the default off leaves the existing booking enabled", async () => {
      const eventType = await createDefaultOnEventType("lc-default-off");
      const existing = await harness.createBooking({
        hostId: host.id,
        label: "lc-default-off-existing",
        eventTypeId: eventType.id,
        startsInMs: TWO_HOURS_MS,
      });
      await choiceService.onBookingCreated({ bookingUid: existing.uid });

      const saved = await choiceService.setEventTypeDefault({
        eventTypeId: eventType.id,
        enabledByDefault: false,
        userId: host.id,
      });
      expect(saved.enabledByDefault).toBe(false);
      expect((await choiceService.getDisclosure({ eventTypeId: eventType.id })).enabledByDefault).toBe(false);

      const state = await choiceService.getState({ bookingUid: existing.uid, userId: host.id });
      expect(state.choice).toMatchObject({ enabled: true, source: "EVENT_TYPE_DEFAULT" });

      const later = await harness.createBooking({
        hostId: host.id,
        label: "lc-default-off-later",
        eventTypeId: eventType.id,
        startsInMs: TWO_HOURS_MS,
      });
      await choiceService.onBookingCreated({ bookingUid: later.uid });
      expect(await findChoice(later.id)).toBeNull();
    });

    it("an in-person event type reports the default as unavailable with a reason", async () => {
      const eventType = await harness.createEventType({
        ownerId: host.id,
        label: "lc-in-person",
        locations: [{ type: "inPerson", address: "1 Example Street" }],
      });

      expect(await choiceService.getEventTypeDefault({ eventTypeId: eventType.id, userId: host.id })).toEqual(
        { enabledByDefault: false, available: false, unavailableReason: "UNSUPPORTED_PLATFORM" }
      );
      await expect(
        choiceService.setEventTypeDefault({
          eventTypeId: eventType.id,
          enabledByDefault: true,
          userId: host.id,
        })
      ).rejects.toMatchObject({ code: ErrorCode.BadRequest, message: "UNSUPPORTED_PLATFORM" });
      expect(await choiceService.getDisclosure({ eventTypeId: eventType.id })).toMatchObject({
        enabledByDefault: false,
        supportedLocationTypes: [],
      });
    });
  });

  // The six cases share one ready booking and each builds on the one before it; keep their order.
  describe("scenario 8: sharing, export, delete and activity", () => {
    let booking: QuickstartBooking;

    beforeAll(async () => {
      booking = await harness.createBooking({
        hostId: host.id,
        label: "lc-share",
        attendees: [{ email: attendee.email, name: attendee.name }],
      });
      const { gateway, dispatch } = harness.createFakeBot("happy");
      await enable(booking);
      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("READY");
    });

    it("sharing lets the matching attendee read and emails the attendee", async () => {
      const shared = await resultsService.setSharing({
        bookingUid: booking.uid,
        shared: true,
        userId: host.id,
      });

      expect(shared).toEqual({ sharedWithAttendees: true });
      expect(sendNotetakerSharedEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerSharedEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: attendee.email, name: attendee.name },
          sharedByName: host.name,
          notetakerUrl: expect.stringContaining(`/booking/${booking.uid}/notetaker`),
        })
      );

      const state = await choiceService.getState({ bookingUid: booking.uid, userId: attendee.id });
      expect(state.viewerRole).toBe("ATTENDEE");
      expect(state.sharedWithAttendees).toBe(true);
      expect(state.choice).toBeNull();
      expect(state.transcript?.passageCount).toBe(3);
      expect(state.summary?.status).toBe("READY");

      const { passages } = await resultsService.listPassages({
        bookingUid: booking.uid,
        userId: attendee.id,
      });
      expect(passages.map((passage) => passage.speakerName)).toEqual(["Alex Example", "Sam Example", null]);
    });

    it("an unrelated user is Forbidden", async () => {
      const params = { bookingUid: booking.uid, userId: outsider.id };

      await expect(choiceService.getState(params)).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      await expect(resultsService.listPassages(params)).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      await expect(resultsService.export({ ...params, format: "markdown" })).rejects.toMatchObject({
        code: ErrorCode.Forbidden,
      });
      await expect(resultsService.getActivity(params)).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("revoking refuses the attendee", async () => {
      const revoked = await resultsService.setSharing({
        bookingUid: booking.uid,
        shared: false,
        userId: host.id,
      });

      expect(revoked).toEqual({ sharedWithAttendees: false });
      const params = { bookingUid: booking.uid, userId: attendee.id };
      await expect(choiceService.getState(params)).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      await expect(resultsService.listPassages(params)).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      const hostState = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      expect(hostState.sharedWithAttendees).toBe(false);
    });

    it("the Markdown export holds the summary and the speaker-attributed transcript", async () => {
      const state = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      const overview = state.summary?.overview;
      if (!overview) throw new Error("The ready booking has no summary overview to look for in the export");

      const exported = await resultsService.export({
        bookingUid: booking.uid,
        format: "markdown",
        userId: host.id,
      });

      expect(exported.mimeType).toBe("text/markdown");
      expect(exported.filename).toMatch(/\.md$/);
      const { content } = exported;
      expect(content).toContain("## en:notetaker_export_summary_heading:{}");
      expect(content).toContain("### en:notetaker_summary_overview:{}");
      expect(content).toContain("### en:notetaker_summary_key_points:{}");
      expect(content).toContain("### en:notetaker_summary_decisions:{}");
      expect(content).toContain("### en:notetaker_summary_action_items:{}");
      expect(content).toContain(escapeMarkdown(overview));
      expect(content).toContain("## en:notetaker_export_transcript_heading:{}");
      expect(content).toContain("**[00:00:00] Alex Example:** Welcome everyone");
      expect(content).toContain("**[00:00:04] Sam Example:** Thanks Alex");
      expect(content).toContain("Sounds good to me");
      expect(content.indexOf("Alex Example:**")).toBeLessThan(content.indexOf("Sam Example:**"));
    });

    it("delete removes the results for everyone and getState reports the deletion", async () => {
      await resultsService.deleteResults({ bookingUid: booking.uid, userId: host.id });

      const state = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      expect(state.transcript).toBeNull();
      expect(state.summary).toBeNull();
      expect(state.session?.resultsDeletedAt).toEqual(expect.any(String));
      expect(state.sharedWithAttendees).toBe(false);

      expect(await prisma.notetakerTranscript.count({ where: { bookingId: booking.id } })).toBe(0);
      const hostParams = { bookingUid: booking.uid, userId: host.id };
      await expect(resultsService.listPassages(hostParams)).rejects.toMatchObject({
        code: ErrorCode.NotFound,
      });
      await expect(resultsService.export({ ...hostParams, format: "markdown" })).rejects.toMatchObject({
        code: ErrorCode.NotFound,
      });
      // Deleted results cannot be exposed again by sharing.
      await expect(resultsService.setSharing({ ...hostParams, shared: true })).rejects.toMatchObject({
        code: ErrorCode.BadRequest,
      });
      await expect(
        choiceService.getState({ bookingUid: booking.uid, userId: attendee.id })
      ).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("the activity list has enable, share, revoke, export and delete with actor and time", async () => {
      const activity = await resultsService.getActivity({ bookingUid: booking.uid, userId: host.id });

      // The service returns newest first.
      expect(activity.map((entry) => entry.action).reverse()).toEqual([
        "ENABLED",
        "SHARED",
        "SHARING_REVOKED",
        "EXPORTED",
        "DELETED",
      ]);
      for (const entry of activity) {
        expect(entry.actorType).toBe("USER");
        expect(entry.actorName).toBe(host.name);
        expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
      }
    });
  });

  describe("scenario 9: booking lifecycle", () => {
    it("reschedule carries the choice to the new booking and the old one is never dispatched", async () => {
      const attendees = [{ email: attendee.email, name: attendee.name }];
      const oldBooking = await harness.createBooking({ hostId: host.id, label: "lc-resched-old", attendees });
      await enable(oldBooking);

      const newBooking = await harness.createBooking({
        hostId: host.id,
        label: "lc-resched-new",
        attendees,
        fromReschedule: oldBooking.uid,
      });
      // What the reschedule flow leaves behind on the booking it replaces.
      await prisma.booking.update({
        where: { id: oldBooking.id },
        data: { status: "CANCELLED", rescheduled: true },
        select: { id: true },
      });
      await choiceService.onBookingRescheduled({ bookingUid: newBooking.uid, oldBookingUid: oldBooking.uid });

      expect(await findChoice(newBooking.id)).toEqual({
        enabled: true,
        pendingDispatch: true,
        source: "HOST",
      });
      const newState = await choiceService.getState({ bookingUid: newBooking.uid, userId: host.id });
      expect(newState.choice).toMatchObject({ enabled: true, source: "HOST", setByName: host.name });
      expect(await findActivities(newBooking.id)).toEqual([
        {
          action: "ENABLED",
          actorType: "SYSTEM",
          detail: { source: "RESCHEDULE", fromBookingUid: oldBooking.uid },
        },
      ]);

      const { gateway, dispatch } = harness.createFakeBot("happy");
      await dispatch.dispatchForBooking({ bookingUid: oldBooking.uid });
      await dispatch.dispatchForBooking({ bookingUid: newBooking.uid });
      await harness.settle(gateway);

      expect(await findSessions(oldBooking.id)).toEqual([]);
      const newSessions = await findSessions(newBooking.id);
      expect(newSessions).toHaveLength(1);
      expect(newSessions[0].status).toBe("READY");
      expect(gateway.joinRequests.map((request) => request.sessionId)).toEqual([newSessions[0].id]);
      // Told once, when the host enabled the old booking: the list of people told travels with the choice.
      expect(noticeRecipients()).toEqual([attendee.email]);
    });

    it("a cancelled booking is not dispatched", async () => {
      const booking = await harness.createBooking({ hostId: host.id, label: "lc-cancelled" });
      await enable(booking);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: "CANCELLED" },
        select: { id: true },
      });

      const { gateway, dispatch } = harness.createFakeBot("happy");
      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);

      expect(gateway.joinRequests).toEqual([]);
      expect(await findSessions(booking.id)).toEqual([]);
      const state = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      expect(state.choice?.enabled).toBe(false);
      expect(state.status).toBeNull();
      expect(state.eligibility).toMatchObject({ eligible: false, reason: "BOOKING_NOT_ACTIVE" });
    });

    it("changing the location to in-person turns the choice off and emails the enabling host", async () => {
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "lc-location",
        startsInMs: TWO_HOURS_MS,
      });
      await enable(booking);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { location: "1 Example Street" },
        select: { id: true },
      });

      const result = await choiceService.onBookingLocationChanged({ bookingId: booking.id });

      expect(result).toEqual({ turnedOff: true });
      expect(await findChoice(booking.id)).toMatchObject({ enabled: false, pendingDispatch: false });
      expect(sendNotetakerTurnedOffEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerTurnedOffEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: host.email, name: host.name },
          notetakerUrl: expect.stringContaining(`/booking/${booking.uid}/notetaker`),
        })
      );
      expect(await findActivities(booking.id)).toEqual([
        { action: "ENABLED", actorType: "USER", detail: null },
        { action: "DISABLED", actorType: "SYSTEM", detail: { reason: "UNSUPPORTED_LOCATION" } },
      ]);
      const state = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      expect(state.eligibility).toMatchObject({ eligible: false, reason: "IN_PERSON_OR_PHONE" });

      // The hook can fire again for the same change; the host is told once.
      expect(await choiceService.onBookingLocationChanged({ bookingId: booking.id })).toEqual({
        turnedOff: false,
      });
      expect(sendNotetakerTurnedOffEmail).toHaveBeenCalledTimes(1);
    });
  });

  // dispatchDue acts on every armed booking and live session in the database, not only this file's.
  describe.skipIf(process.env.NOTETAKER_IT_ISOLATED_DB !== "1")("sweep, isolated database only", () => {
    it("the sweep cancels the pending session of a cancelled booking", async () => {
      const booking = await harness.createBooking({ hostId: host.id, label: "lc-sweep-cancelled" });
      const { gateway, dispatch } = harness.createFakeBot("manual");
      await enable(booking);
      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      const pending = await findSessions(booking.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("SCHEDULED");

      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: "CANCELLED" },
        select: { id: true },
      });
      await dispatch.dispatchDue();

      expect(await findSessions(booking.id)).toEqual([]);
      expect(gateway.stopRequests).toContainEqual({ sessionId: pending[0].id, reason: "BOOKING_NOT_ACTIVE" });
      expect(await findChoice(booking.id)).toMatchObject({ enabled: false, pendingDispatch: false });
      expect(await findActivities(booking.id)).toContainEqual({
        action: "DISABLED",
        actorType: "SYSTEM",
        detail: { reason: "BOOKING_NOT_ACTIVE" },
      });
      expect(gateway.joinRequests).toHaveLength(1);
    });

    it("an unreachable bot ends FAILED with INTERRUPTED after the give-up deadline and sends the failed email", async () => {
      // The give-up deadline is capped at the booking's end, so a booking ending soon keeps the clock
      // change below the heartbeat timeout: a larger one would make the sweep fail the live sessions
      // of the walk-through files running beside this one.
      const durationMs = 20_000;
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "lc-sweep-unreachable",
        startsInMs: 0,
        durationMs,
      });
      const { gateway, dispatch } = harness.createFakeBot("manual");
      const requestJoin = vi
        .spyOn(gateway, "requestJoin")
        .mockRejectedValue(createNotetakerBotGatewayError("TRANSIENT", "bot unreachable"));
      await enable(booking);

      await dispatch.dispatchDue();

      expect(requestJoin).toHaveBeenCalled();
      expect(await findSessions(booking.id)).toEqual([]);
      expect(await findChoice(booking.id)).toMatchObject({ enabled: true, pendingDispatch: true });
      expect(sendNotetakerFailedEmail).not.toHaveBeenCalled();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + durationMs + 1_000);
        await dispatch.dispatchDue();
      } finally {
        vi.useRealTimers();
      }

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ status: "FAILED", outcomeReason: "INTERRUPTED" });
      expect(await findChoice(booking.id)).toMatchObject({ enabled: true, pendingDispatch: false });
      expect(sendNotetakerFailedEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerFailedEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: host.email, name: host.name },
          outcomeReason: "INTERRUPTED",
          notetakerUrl: expect.stringContaining(`/booking/${booking.uid}/notetaker`),
        })
      );
      const state = await choiceService.getState({ bookingUid: booking.uid, userId: host.id });
      expect(state.status).toBe("FAILED");
      expect(state.session?.outcomeReason).toBe("INTERRUPTED");
    });
  });
});
