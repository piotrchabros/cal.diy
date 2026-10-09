import {
  sendNotetakerAdmitPromptEmail,
  sendNotetakerAttendeeNoticeEmail,
  sendNotetakerFailedEmail,
  sendNotetakerResultsReadyEmail,
} from "@calcom/emails/notetaker-email-service";
import { sendNotification } from "@calcom/features/notifications/sendNotification";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getNotetakerChoiceService } from "../di/NotetakerChoiceService.container";
import { getNotetakerResultsService } from "../di/NotetakerResultsService.container";
import { getNotetakerSummaryService } from "../di/NotetakerSummaryService.container";
import type { NotetakerFakeScenario } from "../lib/config";
import type { QuickstartBooking, QuickstartHarness, QuickstartUser } from "./quickstartHarness";
import {
  createQuickstartHarness,
  isQuickstartIsolatedDatabase,
  QUICKSTART_MEET_LINK,
  QUICKSTART_SKIP_MESSAGE,
} from "./quickstartHarness";

// Inlined rather than calling applyQuickstartEnv: hoisted code runs before any import, and importing
// the harness here would load packages/lib/constants.ts before ENABLE_ASYNC_TASKER is set.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The notetaker quickstart walk-through must not run with NODE_ENV=production");
  }
  process.env.ENABLE_ASYNC_TASKER = "false";
  process.env.NOTETAKER_BOT_PROVIDER = "fake";
  process.env.NOTETAKER_BOT_SECRET = "quickstart-it-secret";
  process.env.ANTHROPIC_API_KEY = "";
  delete process.env.NOTETAKER_FAKE_SCENARIO;
  delete process.env.NOTETAKER_SUMMARY_MIN_WORDS;
  delete process.env.NOTETAKER_JOIN_LEAD_SECONDS;
  delete process.env.NOTETAKER_ENABLED_PLATFORMS;
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

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "Notetaker quickstart: core (integration)";
const TWO_HOURS_MS = 2 * 60 * 60_000;

type FakeBot = ReturnType<QuickstartHarness["createFakeBot"]>;
type Attendee = { email: string; name: string };

function urlOf(booking: QuickstartBooking): string {
  return `${WEBAPP_URL}/booking/${booking.uid}/notetaker`;
}

function findSessions(bookingId: number) {
  return prisma.notetakerSession.findMany({
    where: { bookingId },
    select: {
      id: true,
      status: true,
      outcomeReason: true,
      externalRef: true,
      joinRequestedAt: true,
      admittedAt: true,
      noticePostedAt: true,
      interruptedAtMs: true,
      rejoinAttempted: true,
      lastEventSequence: true,
    },
  });
}

function findTranscripts(bookingId: number) {
  return prisma.notetakerTranscript.findMany({
    where: { bookingId },
    select: { id: true, completeness: true, passageCount: true, durationMs: true, language: true },
  });
}

function findChoice(bookingId: number) {
  return prisma.bookingNotetaker.findUnique({
    where: { bookingId },
    select: { enabled: true, pendingDispatch: true, rejoinBlocked: true, notifiedAttendeeEmails: true },
  });
}

function findActivities(bookingId: number) {
  return prisma.notetakerActivity.findMany({
    where: { bookingId },
    orderBy: { createdAt: "asc" },
    select: { action: true, actorType: true, actorUserId: true },
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
  let pushSubscription: { endpoint: string; keys: { auth: string; p256dh: string } };

  const choiceService = getNotetakerChoiceService();
  const resultsService = getNotetakerResultsService();
  const summaryService = getNotetakerSummaryService();

  function setEnabled(booking: QuickstartBooking, enabled: boolean): Promise<void> {
    return choiceService.setEnabled({
      bookingUid: booking.uid,
      enabled,
      scope: "THIS_BOOKING",
      userId: host.id,
    });
  }

  // What setEnabled.handler.ts does for a host: store the choice, then dispatch or stop that one booking.
  async function enable(booking: QuickstartBooking, dispatch: FakeBot["dispatch"]): Promise<void> {
    await setEnabled(booking, true);
    await dispatch.dispatchForBooking({ bookingUid: booking.uid });
  }

  async function disable(booking: QuickstartBooking, dispatch: FakeBot["dispatch"]): Promise<void> {
    await setEnabled(booking, false);
    await dispatch.stopForBooking({ bookingUid: booking.uid, reason: "DISABLED" });
  }

  function getState(booking: QuickstartBooking): Promise<NotetakerStateDto> {
    return choiceService.getState({ bookingUid: booking.uid, userId: host.id });
  }

  function listPassages(
    booking: QuickstartBooking
  ): Promise<{ passages: NotetakerPassageDto[]; nextCursor: number | null }> {
    return resultsService.listPassages({ bookingUid: booking.uid, userId: host.id });
  }

  function guests(label: string): Attendee[] {
    return [
      { email: `notetaker-qs-${label}-g1-${harness.runId}@example.com`, name: "Quickstart Guest One" },
      { email: `notetaker-qs-${label}-g2-${harness.runId}@example.com`, name: "Quickstart Guest Two" },
    ];
  }

  async function runScenario(
    scenario: NotetakerFakeScenario,
    label: string,
    attendees?: Attendee[]
  ): Promise<FakeBot & { booking: QuickstartBooking }> {
    const booking = await harness.createBooking({ hostId: host.id, label, attendees });
    const bot = harness.createFakeBot(scenario);
    await enable(booking, bot.dispatch);
    await harness.settle(bot.gateway);
    return { ...bot, booking };
  }

  beforeAll(async () => {
    harness = await createQuickstartHarness("core");
    host = await harness.createUser({ label: "core-host", notetakerFlag: true });
    pushSubscription = {
      endpoint: `https://push.example.test/${harness.runId}`,
      keys: { auth: "auth", p256dh: "p256dh" },
    };
    // The admit prompt is pushed only to a host with a stored subscription; the row goes with the user.
    await prisma.notificationsSubscriptions.create({
      data: { userId: host.id, subscription: JSON.stringify(pushSubscription) },
      select: { id: true },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  describe("scenario 1: core flow", () => {
    it("happy: enable, dispatch, READY with three passages in order", async () => {
      const booking = await harness.createBooking({ hostId: host.id, label: "core-happy" });
      const { gateway, dispatch } = harness.createFakeBot("happy");

      await setEnabled(booking, true);
      const scheduled = await getState(booking);
      expect(scheduled.status).toBe("SCHEDULED");
      expect(scheduled.session).toBeNull();

      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      const [session] = sessions;
      expect(session).toMatchObject({
        status: "READY",
        outcomeReason: null,
        externalRef: `fake-ref-${session.id}`,
        lastEventSequence: 6,
      });
      expect(session.joinRequestedAt).not.toBeNull();
      expect(session.admittedAt).not.toBeNull();
      expect(session.noticePostedAt).not.toBeNull();

      const transcripts = await findTranscripts(booking.id);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]).toMatchObject({
        completeness: "COMPLETE",
        passageCount: 3,
        durationMs: 12000,
        language: "en",
      });

      const { passages, nextCursor } = await listPassages(booking);
      expect(nextCursor).toBeNull();
      expect(passages.map((passage) => passage.index)).toEqual([0, 1, 2]);
      expect(passages.map((passage) => passage.speakerName)).toEqual(["Alex Example", "Sam Example", null]);
      expect(passages.map((passage) => passage.unknownSpeakerNumber)).toEqual([null, null, 1]);
      expect(passages.map((passage) => passage.startMs)).toEqual([0, 4500, 9500]);
      for (const passage of passages) {
        expect(passage).not.toHaveProperty("speakerKey");
      }

      expect(await findChoice(booking.id)).toMatchObject({ enabled: true, pendingDispatch: false });
      expect(gateway.joinRequests).toHaveLength(1);
      expect((await getState(booking)).status).toBe("READY");
    });

    it("happy: a results-ready email goes to the host and carries no transcript or summary text", async () => {
      const { booking } = await runScenario("happy", "core-happy-email");

      expect(sendNotetakerResultsReadyEmail).toHaveBeenCalledTimes(1);
      const input = vi.mocked(sendNotetakerResultsReadyEmail).mock.calls[0][0];
      expect(input).toMatchObject({
        to: { email: host.email, name: host.name },
        resultsUrl: urlOf(booking),
        sessionStatus: "READY",
        outcomeReason: null,
        transcriptCompleteness: "COMPLETE",
        summaryStatus: "READY",
        locale: "en",
      });

      const serialized = JSON.stringify(input);
      expect(serialized).toContain(`/booking/${booking.uid}/notetaker`);

      const { passages } = await listPassages(booking);
      expect(passages).toHaveLength(3);
      for (const passage of passages) {
        expect(passage.text.length).toBeGreaterThan(0);
        expect(serialized).not.toContain(passage.text);
      }

      const [transcript] = await findTranscripts(booking.id);
      const summary = await prisma.notetakerSummary.findUnique({
        where: { transcriptId: transcript.id },
        select: { overview: true },
      });
      const overview = summary?.overview;
      if (!overview) throw new Error("The ready booking has no summary overview to look for in the email");
      expect(serialized).not.toContain(overview);
    });

    it("getState after enabling a booking that is not yet due is SCHEDULED-free and enabled", async () => {
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "core-not-due",
        startsInMs: TWO_HOURS_MS,
      });
      const { gateway, dispatch } = harness.createFakeBot("happy");

      await enable(booking, dispatch);

      expect(gateway.joinRequests).toEqual([]);
      expect(await findSessions(booking.id)).toEqual([]);
      const state = await getState(booking);
      expect(state.choice).toMatchObject({ enabled: true, source: "HOST", setByName: host.name });
      expect(state.session).toBeNull();
      expect(state.canToggle).toBe(true);
      expect(state.canStop).toBe(false);
      expect(state.eligibility).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
      // Quickstart 1: "After enabling, the status is scheduled", with no session behind it yet.
      expect(state.status).toBe("SCHEDULED");
    });
  });

  describe("scenario 2: turning it off, and never turning it on", () => {
    it("enable then disable before dispatch leaves no session, transcript or notice", async () => {
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "core-off",
        startsInMs: TWO_HOURS_MS,
      });
      const { gateway, dispatch } = harness.createFakeBot("happy");

      await enable(booking, dispatch);
      await disable(booking, dispatch);

      // The sweep reaches a booking only inside its join window, so the booking is moved into it.
      await prisma.booking.update({
        where: { id: booking.id },
        data: { startTime: new Date(Date.now() + 60_000), endTime: new Date(Date.now() + 31 * 60_000) },
        select: { id: true },
      });
      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);

      expect(await findSessions(booking.id)).toEqual([]);
      expect(await findTranscripts(booking.id)).toEqual([]);
      expect(gateway.joinRequests).toEqual([]);
      expect(gateway.stopRequests).toEqual([]);
      expect(await findChoice(booking.id)).toMatchObject({ enabled: false, pendingDispatch: false });
      expect(sendNotetakerAttendeeNoticeEmail).not.toHaveBeenCalled();
    });

    it("a booking that was never enabled is not dispatched", async () => {
      const booking = await harness.createBooking({ hostId: host.id, label: "core-never" });
      const { gateway, dispatch } = harness.createFakeBot("happy");

      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);

      expect(await findChoice(booking.id)).toBeNull();
      expect(await findSessions(booking.id)).toEqual([]);
      expect(await findTranscripts(booking.id)).toEqual([]);
      expect(gateway.joinRequests).toEqual([]);
    });
  });

  describe("scenario 3: transparency and removal by a participant", () => {
    it("enabling notifies every attendee once and names the host", async () => {
      const attendees = guests("core-notice");
      const { booking } = await runScenario("happy", "core-notice", attendees);

      expect(sendNotetakerAttendeeNoticeEmail).toHaveBeenCalledTimes(2);
      const expectedEmails = attendees.map((attendee) => attendee.email).sort();
      expect(noticeRecipients().sort()).toEqual(expectedEmails);
      for (const [input] of vi.mocked(sendNotetakerAttendeeNoticeEmail).mock.calls) {
        expect(input).toMatchObject({
          hostName: host.name,
          isPending: false,
          bookingTitle: expect.any(String),
        });
      }
      const choice = await findChoice(booking.id);
      expect([...(choice?.notifiedAttendeeEmails ?? [])].sort()).toEqual(expectedEmails);
    });

    it("off and on again does not notify attendees already told", async () => {
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "core-renotice",
        startsInMs: TWO_HOURS_MS,
        attendees: guests("core-renotice"),
      });
      const { dispatch } = harness.createFakeBot("happy");

      await enable(booking, dispatch);
      expect(sendNotetakerAttendeeNoticeEmail).toHaveBeenCalledTimes(2);
      vi.clearAllMocks();

      await disable(booking, dispatch);
      await enable(booking, dispatch);

      expect(sendNotetakerAttendeeNoticeEmail).not.toHaveBeenCalled();
      expect(await findChoice(booking.id)).toMatchObject({ enabled: true, pendingDispatch: true });
    });

    it("the join request carries a display name with the host and a localized notice message", async () => {
      const { booking, gateway } = await runScenario("happy", "core-join-request");

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      const stored = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { startTime: true },
      });

      expect(gateway.joinRequests).toHaveLength(1);
      // The i18n mock renders "<locale>:<key>:<vars>", so the "en:" prefix is the organizer's locale.
      expect(gateway.joinRequests[0]).toEqual({
        sessionId: sessions[0].id,
        platform: "GOOGLE_MEET",
        meetingUrl: QUICKSTART_MEET_LINK,
        displayName: `en:notetaker_display_name:${JSON.stringify({ appName: APP_NAME, hostName: host.name })}`,
        noticeMessage: `en:notetaker_meeting_notice:${JSON.stringify({ hostName: host.name })}`,
        scheduledStartAt: stored.startTime.toISOString(),
        callbackUrl: `${WEBAPP_URL}/api/notetaker/events`,
        limits: {
          admissionTimeoutSeconds: 600,
          noShowTimeoutSeconds: 900,
          aloneTimeoutSeconds: 120,
          maxDurationSeconds: 14400,
        },
      });
    });

    it("removed_by_participant ends ENDED_EARLY with a partial transcript and blocks re-enabling", async () => {
      const { booking, dispatch, gateway } = await runScenario("removed_by_participant", "core-removed");

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ status: "ENDED_EARLY", outcomeReason: "REMOVED_BY_PARTICIPANT" });
      const transcripts = await findTranscripts(booking.id);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]).toMatchObject({ completeness: "PARTIAL", passageCount: 2 });
      expect(await findChoice(booking.id)).toMatchObject({ rejoinBlocked: true, pendingDispatch: false });

      await expect(setEnabled(booking, true)).rejects.toMatchObject({
        code: ErrorCode.BadRequest,
        message: "REJOIN_BLOCKED",
        data: { reason: "REJOIN_BLOCKED" },
      });

      const state = await getState(booking);
      expect(state.canToggle).toBe(false);
      expect(state.status).toBe("ENDED_EARLY");
      expect(state.session?.outcomeReason).toBe("REMOVED_BY_PARTICIPANT");
      expect(state.eligibility).toEqual({
        eligible: false,
        platform: "GOOGLE_MEET",
        reason: "REJOIN_BLOCKED",
      });

      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);
      expect(await findSessions(booking.id)).toHaveLength(1);
      expect(gateway.joinRequests).toHaveLength(1);

      expect(await findActivities(booking.id)).toContainEqual({
        action: "STOPPED",
        actorType: "PARTICIPANT",
        actorUserId: null,
      });
    });
  });

  describe("scenario 5: summary and its failure modes", () => {
    it("happy summary is READY with overview, key points, decisions and action items", async () => {
      const { booking } = await runScenario("happy", "core-summary");

      const state = await getState(booking);
      expect(state.summary).toMatchObject({ status: "READY", language: "en" });
      expect(state.summary?.overview).toEqual(expect.any(String));
      expect(state.summary?.overview?.length).toBeGreaterThan(0);
      expect(state.summary?.keyPoints).toHaveLength(3);
      expect(state.summary?.decisions).toHaveLength(2);
      expect(state.summary?.actionItems).toEqual([
        { text: expect.stringContaining("release notes"), owner: "Sam Example" },
      ]);
      expect(state.transcript).toMatchObject({ completeness: "COMPLETE", passageCount: 3 });
    });

    it("no_speech ends FAILED with NO_SPEECH_DETECTED and has no summary", async () => {
      const { booking } = await runScenario("no_speech", "core-no-speech");

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ status: "FAILED", outcomeReason: "NO_SPEECH_DETECTED" });
      expect(await findTranscripts(booking.id)).toEqual([]);

      const state = await getState(booking);
      expect(state.status).toBe("FAILED");
      expect(state.transcript).toBeNull();
      expect(state.summary).toBeNull();

      expect(sendNotetakerFailedEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerFailedEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          outcomeReason: "NO_SPEECH_DETECTED",
          notetakerUrl: urlOf(booking),
          canEnableAgain: true,
        })
      );
      expect(sendNotetakerResultsReadyEmail).not.toHaveBeenCalled();
    });

    it("a FAILED summary keeps the transcript readable and regeneration brings it back to READY", async () => {
      const { booking } = await runScenario("happy", "core-regenerate");
      const [transcript] = await findTranscripts(booking.id);

      // Stands in for a generator failure: the stub generator cannot be made to fail from outside.
      await prisma.notetakerSummary.update({
        where: { transcriptId: transcript.id },
        data: { status: "FAILED", failureCode: "QUICKSTART_FORCED" },
        select: { id: true },
      });
      vi.clearAllMocks();

      const failed = await getState(booking);
      expect(failed.summary?.status).toBe("FAILED");
      expect(failed.transcript).toMatchObject({ completeness: "COMPLETE", passageCount: 3 });
      expect((await listPassages(booking)).passages).toHaveLength(3);

      const requested = await summaryService.requestRegeneration({
        bookingUid: booking.uid,
        userId: host.id,
      });
      // The contract answers PENDING even though the sync tasker has already finished the run.
      expect(requested.status).toBe("PENDING");

      const regenerated = await getState(booking);
      expect(regenerated.summary?.status).toBe("READY");
      expect(regenerated.summary?.overview?.length).toBeGreaterThan(0);
      expect(sendNotetakerResultsReadyEmail).not.toHaveBeenCalled();
      expect(await findActivities(booking.id)).toContainEqual({
        action: "SUMMARY_REQUESTED",
        actorType: "USER",
        actorUserId: host.id,
      });
    });
  });

  describe("scenario 6: failure reasons, admit prompt and incomplete transcripts", () => {
    it("not_admitted prompts the host, ends FAILED with NOT_ADMITTED, keeps no transcript and sends the failed email", async () => {
      const { booking } = await runScenario("not_admitted", "core-not-admitted");

      expect(sendNotetakerAdmitPromptEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerAdmitPromptEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: host.email, name: host.name },
          notetakerUrl: urlOf(booking),
        })
      );
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription: pushSubscription,
          url: urlOf(booking),
          type: "NOTETAKER_ADMIT_PROMPT",
          requireInteraction: true,
          title: "en:notetaker_admit_push_title:{}",
        })
      );

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: "FAILED",
        outcomeReason: "NOT_ADMITTED",
        admittedAt: null,
      });
      expect(await findTranscripts(booking.id)).toEqual([]);

      expect(sendNotetakerFailedEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerFailedEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: host.email, name: host.name },
          outcomeReason: "NOT_ADMITTED",
          canEnableAgain: true,
        })
      );

      const state = await getState(booking);
      expect(state.status).toBe("FAILED");
      expect(state.session?.outcomeReason).toBe("NOT_ADMITTED");
      expect(state.transcript).toBeNull();
    });

    it("interrupted ends ENDED_EARLY, PARTIAL, with the interruption point", async () => {
      const { booking } = await runScenario("interrupted", "core-interrupted");

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: "ENDED_EARLY",
        outcomeReason: "INTERRUPTED",
        interruptedAtMs: 9000,
        rejoinAttempted: true,
      });
      const transcripts = await findTranscripts(booking.id);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]).toMatchObject({ completeness: "PARTIAL", passageCount: 2 });

      const state = await getState(booking);
      expect(state.status).toBe("ENDED_EARLY");
      expect(state.session?.outcomeReason).toBe("INTERRUPTED");
      expect(state.session?.interruptedAtMs).toBe(9000);
      expect(state.transcript?.completeness).toBe("PARTIAL");
    });

    it("length_limit ends READY, TRUNCATED, with LENGTH_LIMIT_REACHED", async () => {
      const { booking } = await runScenario("length_limit", "core-length-limit");

      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ status: "READY", outcomeReason: "LENGTH_LIMIT_REACHED" });
      const transcripts = await findTranscripts(booking.id);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]).toMatchObject({
        completeness: "TRUNCATED",
        passageCount: 2,
        durationMs: 14_400_000,
      });

      expect(sendNotetakerResultsReadyEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerResultsReadyEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionStatus: "READY",
          outcomeReason: "LENGTH_LIMIT_REACHED",
          transcriptCompleteness: "TRUNCATED",
        })
      );

      const state = await getState(booking);
      expect(state.status).toBe("READY");
      expect(state.session?.outcomeReason).toBe("LENGTH_LIMIT_REACHED");
      expect(state.transcript?.completeness).toBe("TRUNCATED");
    });

    it("link_unusable ends FAILED with MEETING_LINK_UNUSABLE", async () => {
      const { booking, gateway } = await runScenario("link_unusable", "core-link-unusable");

      // The fake records the request before refusing it.
      expect(gateway.joinRequests).toHaveLength(1);
      const sessions = await findSessions(booking.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ status: "FAILED", outcomeReason: "MEETING_LINK_UNUSABLE" });
      expect(await findTranscripts(booking.id)).toEqual([]);
      expect(await findChoice(booking.id)).toMatchObject({ pendingDispatch: false });

      expect(sendNotetakerFailedEmail).toHaveBeenCalledTimes(1);
      expect(sendNotetakerFailedEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: { email: host.email, name: host.name },
          outcomeReason: "MEETING_LINK_UNUSABLE",
          notetakerUrl: urlOf(booking),
        })
      );
      expect(sendNotetakerAdmitPromptEmail).not.toHaveBeenCalled();

      const state = await getState(booking);
      expect(state.status).toBe("FAILED");
      expect(state.session?.outcomeReason).toBe("MEETING_LINK_UNUSABLE");
    });
  });

  describe("scenario 10: compatibility", () => {
    it("a Cal Video booking is ineligible with CAL_VIDEO and cannot be enabled", async () => {
      const booking = await harness.createBooking({
        hostId: host.id,
        label: "core-cal-video",
        location: "integrations:daily",
      });
      const { gateway, dispatch } = harness.createFakeBot("happy");

      expect(await getState(booking)).toMatchObject({
        featureEnabled: true,
        viewerRole: "HOST",
        eligibility: { eligible: false, platform: null, reason: "CAL_VIDEO" },
        canToggle: false,
        choice: null,
        status: null,
      });

      await expect(setEnabled(booking, true)).rejects.toMatchObject({
        code: ErrorCode.BadRequest,
        message: "CAL_VIDEO",
        data: { reason: "CAL_VIDEO" },
      });
      expect(await findChoice(booking.id)).toBeNull();

      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      await harness.settle(gateway);

      expect(await findSessions(booking.id)).toEqual([]);
      expect(gateway.joinRequests).toEqual([]);
    });
  });
});
