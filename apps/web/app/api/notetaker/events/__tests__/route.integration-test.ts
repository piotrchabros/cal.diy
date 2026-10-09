import { randomUUID } from "node:crypto";
import type { FakeBotGateway } from "@calcom/features/notetaker/bot/FakeBotGateway";
import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import type { NotetakerDispatchService } from "@calcom/features/notetaker/services/NotetakerDispatchService";
import type {
  QuickstartBooking,
  QuickstartHarness,
  QuickstartUser,
} from "@calcom/features/notetaker/tests/quickstartHarness";
import {
  createQuickstartHarness,
  isQuickstartIsolatedDatabase,
  QUICKSTART_BOT_SECRET,
  QUICKSTART_SKIP_MESSAGE,
} from "@calcom/features/notetaker/tests/quickstartHarness";
import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  NotetakerBotEndReason,
  NotetakerBotEvent,
  NotetakerBotPassage,
} from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  signNotetakerPayload,
} from "@calcom/lib/notetaker/botContract";
import { prisma } from "@calcom/prisma";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

// Inlined copy of applyQuickstartEnv: hoisted code runs before the imports, and
// packages/lib/constants.ts reads ENABLE_ASYNC_TASKER when it is first imported.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The notetaker walk-through must not run with NODE_ENV=production");
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

// The default DATABASE_URL of this checkout is a live site's database. These tests write rows, so
// they only run against the throwaway database the owner provided for them.
const isIsolatedDatabase = isQuickstartIsolatedDatabase();

const EVENTS_URL = "http://localhost/api/notetaker/events";
const UNKNOWN_SESSION_ID = "00000000-0000-4000-8000-ffffffffffff";
const STALE_SECONDS = 301;

const INVALID_SIGNATURE_BODY = { message: "Invalid signature" };
const GONE_BODY = { message: "Session is gone" };
const OK_BODY = { ok: true };

const FIRST_PASSAGES: NotetakerBotPassage[] = [
  {
    index: 0,
    speakerKey: "speaker-1",
    speakerName: "Alex Example",
    unknownSpeakerNumber: null,
    startMs: 0,
    endMs: 4000,
    text: "Welcome everyone, today we need to decide when the new booking page goes live.",
    language: "en",
  },
  {
    index: 1,
    speakerKey: "speaker-2",
    speakerName: "Sam Example",
    unknownSpeakerNumber: null,
    startMs: 4500,
    endMs: 9000,
    text: "Testing is finished, so we agreed to launch on Monday, and I will send the release notes today.",
    language: "en",
  },
];

const LATE_PASSAGE: NotetakerBotPassage = {
  index: 2,
  speakerKey: "speaker-3",
  speakerName: null,
  unknownSpeakerNumber: 1,
  startMs: 9500,
  endMs: 12000,
  text: "Sounds good to me.",
  language: "en",
};

type ManualSession = {
  booking: QuickstartBooking;
  sessionId: string;
  gateway: FakeBotGateway;
  dispatch: NotetakerDispatchService;
};

function envelope(
  sessionId: string,
  sequence: number
): { eventId: string; sessionId: string; sequence: number; occurredAt: string } {
  return { eventId: randomUUID(), sessionId, sequence, occurredAt: new Date().toISOString() };
}

function admitted(sessionId: string, sequence: number): NotetakerBotEvent {
  return { ...envelope(sessionId, sequence), type: "session.admitted", data: {} };
}

function heartbeat(sessionId: string, sequence: number): NotetakerBotEvent {
  return { ...envelope(sessionId, sequence), type: "session.heartbeat", data: { participantCount: 2 } };
}

function passagesEvent(
  sessionId: string,
  sequence: number,
  passages: NotetakerBotPassage[]
): NotetakerBotEvent {
  return { ...envelope(sessionId, sequence), type: "transcript.passages", data: { passages } };
}

function ended(
  sessionId: string,
  sequence: number,
  data: { endReason: NotetakerBotEndReason; passageCount: number }
): NotetakerBotEvent {
  return {
    ...envelope(sessionId, sequence),
    type: "session.ended",
    data: { ...data, durationMs: 12_000, interruptedAtMs: null },
  };
}

function signedHeaders(
  rawBody: string,
  overrides: { secret?: string; ageSeconds?: number } = {}
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000) - (overrides.ageSeconds ?? 0));
  return {
    [NOTETAKER_TIMESTAMP_HEADER]: timestamp,
    [NOTETAKER_SIGNATURE_HEADER]: signNotetakerPayload({
      secret: overrides.secret ?? QUICKSTART_BOT_SECRET,
      timestamp,
      rawBody,
    }),
  };
}

// A request body can be read once, so every call builds a new request, including a replay.
async function postRaw(
  rawBody: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const request = new NextRequest(EVENTS_URL, { method: "POST", body: rawBody, headers });
  const response = await POST(request, { params: Promise.resolve({}) });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

function post(
  event: NotetakerBotEvent,
  opts: { secret?: string; ageSeconds?: number } = {}
): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(event);
  return postRaw(rawBody, signedHeaders(rawBody, opts));
}

function findSession(sessionId: string) {
  return prisma.notetakerSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      outcomeReason: true,
      lastEventSequence: true,
      admittedAt: true,
      endedAt: true,
      lastHeartbeatAt: true,
      stopRequestedAt: true,
      stopRequestedByUserId: true,
      resultsDeletedAt: true,
      updatedAt: true,
    },
  });
}

function findSessionIds(bookingId: number) {
  return prisma.notetakerSession.findMany({ where: { bookingId }, select: { id: true } });
}

function findTranscript(sessionId: string) {
  return prisma.notetakerTranscript.findUnique({
    where: { sessionId },
    select: { completeness: true, passageCount: true },
  });
}

function findPassages(sessionId: string) {
  return prisma.notetakerTranscriptPassage.findMany({
    where: { transcript: { sessionId } },
    orderBy: { index: "asc" },
    select: { index: true, speakerName: true, unknownSpeakerNumber: true, text: true },
  });
}

function countTranscripts(bookingId: number): Promise<number> {
  return prisma.notetakerTranscript.count({ where: { bookingId } });
}

function findChoice(bookingId: number) {
  return prisma.bookingNotetaker.findUnique({
    where: { bookingId },
    select: { enabled: true, pendingDispatch: true, rejoinBlocked: true },
  });
}

function findStopActivities(bookingId: number) {
  return prisma.notetakerActivity.findMany({
    where: { bookingId, action: "STOPPED" },
    select: { actorType: true, actorUserId: true, sessionId: true },
  });
}

describe.runIf(!isIsolatedDatabase)("POST /api/notetaker/events (integration), not run", () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!isIsolatedDatabase)("POST /api/notetaker/events (integration)", () => {
  let harness: QuickstartHarness | undefined;
  let host: QuickstartUser | undefined;

  function requireSetup(): { harness: QuickstartHarness; host: QuickstartUser } {
    if (harness === undefined || host === undefined) {
      throw new Error("Test setup did not complete: harness or host is missing");
    }
    return { harness, host };
  }

  // What setEnabled.handler.ts does for a due booking, with a bot that plays no script.
  async function startManualSession(label: string): Promise<ManualSession> {
    const setup = requireSetup();
    const booking = await setup.harness.createBooking({ hostId: setup.host.id, label });
    const { gateway, dispatch } = setup.harness.createFakeBot("manual");

    await getNotetakerChoiceService().setEnabled({
      bookingUid: booking.uid,
      enabled: true,
      scope: "THIS_BOOKING",
      userId: setup.host.id,
    });
    await dispatch.dispatchForBooking({ bookingUid: booking.uid });

    const sessions = await findSessionIds(booking.id);
    expect(sessions).toHaveLength(1);
    return { booking, sessionId: sessions[0].id, gateway, dispatch };
  }

  async function startTranscribingSession(label: string): Promise<ManualSession> {
    const session = await startManualSession(label);
    expect(await post(admitted(session.sessionId, 1))).toEqual({ status: 200, body: OK_BODY });
    return session;
  }

  async function startSessionWithSpeech(label: string): Promise<ManualSession> {
    const session = await startTranscribingSession(label);
    expect(await post(passagesEvent(session.sessionId, 2, FIRST_PASSAGES))).toEqual({
      status: 200,
      body: OK_BODY,
    });
    return session;
  }

  async function startEndedSession(label: string): Promise<ManualSession> {
    const session = await startSessionWithSpeech(label);
    expect(await post(ended(session.sessionId, 3, { endReason: "MEETING_ENDED", passageCount: 2 }))).toEqual({
      status: 200,
      body: OK_BODY,
    });
    return session;
  }

  beforeAll(async () => {
    harness = await createQuickstartHarness("events-route");
    host = await harness.createUser({ label: "host", notetakerFlag: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  describe("scenario 11: event contract", () => {
    it("a wrong signature is 401 and stores nothing", async () => {
      const { sessionId } = await startTranscribingSession("wrong-signature");
      const before = await findSession(sessionId);

      const response = await post(passagesEvent(sessionId, 2, FIRST_PASSAGES), {
        secret: "another-secret",
      });

      expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
      expect(await findPassages(sessionId)).toEqual([]);
      expect(await findTranscript(sessionId)).toBeNull();
      expect(await findSession(sessionId)).toEqual(before);
    });

    it("a stale timestamp is 401", async () => {
      const { sessionId } = await startTranscribingSession("stale-timestamp");
      const before = await findSession(sessionId);

      const response = await post(passagesEvent(sessionId, 2, FIRST_PASSAGES), {
        ageSeconds: STALE_SECONDS,
      });

      expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
      expect(await findPassages(sessionId)).toEqual([]);
      expect(await findSession(sessionId)).toEqual(before);
    });

    it("a replayed passages event is 200 and stores no duplicate", async () => {
      const { sessionId } = await startTranscribingSession("replay");
      const rawBody = JSON.stringify(passagesEvent(sessionId, 2, FIRST_PASSAGES));
      const headers = signedHeaders(rawBody);

      const first = await postRaw(rawBody, headers);
      const afterFirst = await findPassages(sessionId);
      const replay = await postRaw(rawBody, headers);

      expect(first).toEqual({ status: 200, body: OK_BODY });
      expect(replay).toEqual({ status: 200, body: OK_BODY });
      expect(afterFirst).toHaveLength(2);
      expect(await findPassages(sessionId)).toEqual(afterFirst);
      expect((await findSession(sessionId))?.lastEventSequence).toBe(2);
    });

    it("an unknown session is 410", async () => {
      const response = await post(heartbeat(UNKNOWN_SESSION_ID, 1));

      expect(response).toEqual({ status: 410, body: GONE_BODY });
      expect(await findSession(UNKNOWN_SESSION_ID)).toBeNull();
    });

    it("a session whose results were deleted is 410", async () => {
      const setup = requireSetup();
      const { booking, sessionId } = await startEndedSession("deleted-results");
      await getNotetakerResultsService().deleteResults({ bookingUid: booking.uid, userId: setup.host.id });
      const before = await findSession(sessionId);

      const response = await post(passagesEvent(sessionId, 4, [LATE_PASSAGE]));

      expect(before?.resultsDeletedAt).not.toBeNull();
      expect(response).toEqual({ status: 410, body: GONE_BODY });
      expect(await countTranscripts(booking.id)).toBe(0);
      expect(await findSession(sessionId)).toEqual(before);
    });

    it("a terminal session is 410", async () => {
      const { sessionId } = await startEndedSession("terminal");
      const before = await findSession(sessionId);

      const response = await post(passagesEvent(sessionId, 4, [LATE_PASSAGE]));

      expect(before).toMatchObject({ status: "READY", outcomeReason: null });
      expect(response).toEqual({ status: 410, body: GONE_BODY });
      expect(await findPassages(sessionId)).toHaveLength(2);
      expect(await findSession(sessionId)).toEqual(before);
    });

    it("a PROCESSING session is 410 and is not changed", async () => {
      const { sessionId } = await startSessionWithSpeech("processing");
      await prisma.notetakerSession.update({
        where: { id: sessionId },
        data: { status: "PROCESSING" },
        select: { id: true },
      });
      const before = await findSession(sessionId);

      const lateHeartbeat = await post(heartbeat(sessionId, 3));
      const latePassages = await post(passagesEvent(sessionId, 4, [LATE_PASSAGE]));

      expect(lateHeartbeat).toEqual({ status: 410, body: GONE_BODY });
      expect(latePassages).toEqual({ status: 410, body: GONE_BODY });
      expect(await findPassages(sessionId)).toHaveLength(2);
      expect(await findSession(sessionId)).toEqual(before);
    });
  });

  describe("scenario 4: host stop", () => {
    it("host stop after speech: stop request recorded, end event, ENDED_EARLY with STOPPED_BY_HOST and a partial transcript, re-enabling refused", async () => {
      const setup = requireSetup();
      const { booking, sessionId, gateway, dispatch } = await startSessionWithSpeech("stop-after-speech");

      await dispatch.stopForBooking({
        bookingUid: booking.uid,
        reason: "STOPPED_BY_HOST",
        userId: setup.host.id,
      });

      expect(gateway.stopRequests).toEqual([{ sessionId, reason: "STOPPED_BY_HOST" }]);
      const stopping = await findSession(sessionId);
      expect(stopping?.status).toBe("TRANSCRIBING");
      expect(stopping?.stopRequestedAt).not.toBeNull();
      expect(stopping?.stopRequestedByUserId).toBe(setup.host.id);

      const response = await post(ended(sessionId, 3, { endReason: "STOP_REQUESTED", passageCount: 2 }));

      expect(response).toEqual({ status: 200, body: OK_BODY });
      expect(await findSession(sessionId)).toMatchObject({
        status: "ENDED_EARLY",
        outcomeReason: "STOPPED_BY_HOST",
      });
      expect(await findTranscript(sessionId)).toEqual({ completeness: "PARTIAL", passageCount: 2 });
      expect(await findPassages(sessionId)).toEqual([
        { index: 0, speakerName: "Alex Example", unknownSpeakerNumber: null, text: FIRST_PASSAGES[0].text },
        { index: 1, speakerName: "Sam Example", unknownSpeakerNumber: null, text: FIRST_PASSAGES[1].text },
      ]);
      expect(await findStopActivities(booking.id)).toEqual([
        { actorType: "USER", actorUserId: setup.host.id, sessionId },
      ]);

      const choiceService = getNotetakerChoiceService();
      const reEnable = choiceService.setEnabled({
        bookingUid: booking.uid,
        enabled: true,
        scope: "THIS_BOOKING",
        userId: setup.host.id,
      });
      await expect(reEnable).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(reEnable).rejects.toMatchObject({ message: "REJOIN_BLOCKED" });

      // The notetaker does not rejoin: a later dispatch for the booking sends no second bot.
      await dispatch.dispatchForBooking({ bookingUid: booking.uid });
      expect(gateway.joinRequests).toHaveLength(1);
      expect(await findSessionIds(booking.id)).toEqual([{ id: sessionId }]);
      expect(await findChoice(booking.id)).toMatchObject({ pendingDispatch: false, rejoinBlocked: true });

      const state = await choiceService.getState({ bookingUid: booking.uid, userId: setup.host.id });
      expect(state.status).toBe("ENDED_EARLY");
      expect(state.session?.outcomeReason).toBe("STOPPED_BY_HOST");
      expect(state.transcript?.completeness).toBe("PARTIAL");
      expect(state.eligibility).toMatchObject({ eligible: false, reason: "REJOIN_BLOCKED" });
      expect(state.canToggle).toBe(false);
      expect(state.canStop).toBe(false);
    });

    it("host stop before any speech ends FAILED with STOPPED_BY_HOST and no transcript", async () => {
      const setup = requireSetup();
      const { booking, sessionId, gateway, dispatch } = await startTranscribingSession("stop-before-speech");

      await dispatch.stopForBooking({
        bookingUid: booking.uid,
        reason: "STOPPED_BY_HOST",
        userId: setup.host.id,
      });
      const response = await post(ended(sessionId, 2, { endReason: "STOP_REQUESTED", passageCount: 0 }));

      expect(gateway.stopRequests).toEqual([{ sessionId, reason: "STOPPED_BY_HOST" }]);
      expect(response).toEqual({ status: 200, body: OK_BODY });
      expect(await findSession(sessionId)).toMatchObject({
        status: "FAILED",
        outcomeReason: "STOPPED_BY_HOST",
      });
      expect(await countTranscripts(booking.id)).toBe(0);
      expect(await findSessionIds(booking.id)).toEqual([{ id: sessionId }]);

      const state = await getNotetakerChoiceService().getState({
        bookingUid: booking.uid,
        userId: setup.host.id,
      });
      expect(state.status).toBe("FAILED");
      expect(state.session?.outcomeReason).toBe("STOPPED_BY_HOST");
      expect(state.transcript).toBeNull();
    });
  });
});
