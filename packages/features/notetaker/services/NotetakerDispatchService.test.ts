import { MeetLocationType } from "@calcom/app-store/constants";
import { createContainer } from "@calcom/features/di/di";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  NotetakerBotEvent,
  NotetakerBotJoinRequest,
  NotetakerBotStopReason,
} from "@calcom/lib/notetaker/botContract";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBotGateway } from "../bot/FakeBotGateway";
import type {
  INotetakerBotGateway,
  INotetakerBotGatewayResolver,
  NotetakerBotGatewayBinding,
} from "../bot/INotetakerBotGateway";
import { createNotetakerBotGatewayError } from "../bot/INotetakerBotGateway";
import { moduleLoader as botGatewayModuleLoader } from "../di/NotetakerBotGateway.module";
import type { NotetakerConfig, NotetakerFakeScenario } from "../lib/config";
import { getNotetakerConfig, NOTETAKER_SWEEP_BATCH_SIZE } from "../lib/config";
import { NOTETAKER_LIVE_SESSION_STATUSES } from "../lib/sessionStateMachine";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { NotetakerSessionUpdateInput } from "../repositories/interfaces/INotetakerSessionRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerAccessService } from "./NotetakerAccessService";
import { getNotetakerGiveUpDeadline, NotetakerDispatchService } from "./NotetakerDispatchService";

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(
    async (locale: string) => (key: string, vars?: Record<string, string>) =>
      `${locale}:${key}:${JSON.stringify(vars ?? {})}`
  ),
}));

const NOW = new Date("2026-10-12T09:59:00.000Z");
const START = new Date("2026-10-12T10:00:00.000Z");
const END = new Date("2026-10-12T10:30:00.000Z");

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;
const CO_HOST_ID = 2;
const STRANGER_ID = 999;
const ORGANIZER_NAME = "Organizer";
const ORGANIZER_EMAIL = "organizer@example.com";
const MEET_LINK = "https://meet.google.com/abc-defg-hij";

const EXPECTED_DISPLAY_NAME = `en:notetaker_display_name:${JSON.stringify({ appName: APP_NAME, hostName: "Organizer" })}`;
const EXPECTED_NOTICE = `en:notetaker_meeting_notice:${JSON.stringify({ hostName: "Organizer" })}`;

function buildBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return {
    id: BOOKING_ID,
    uid: BOOKING_UID,
    userId: ORGANIZER_ID,
    status: "ACCEPTED",
    startTime: START,
    endTime: END,
    title: "Planning call",
    location: MEET_LINK,
    metadata: null,
    recurringEventId: null,
    eventTypeId: 10,
    attendeeEmails: ["attendee@example.com"],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
}

function offsetFromNow(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function createStubGateway(overrides: Partial<INotetakerBotGateway> = {}): INotetakerBotGateway {
  return {
    requestJoin: async (input) => ({ externalRef: `stub-ref-${input.sessionId}` }),
    requestStop: async () => {},
    getState: async () => null,
    ...overrides,
  };
}

function createTransientGateway(): INotetakerBotGateway {
  return createStubGateway({
    requestJoin: async () => {
      throw createNotetakerBotGatewayError("TRANSIENT", "bot unreachable");
    },
  });
}

class RecordingTasker implements INotetakerTasker {
  finalizeCalls: { payload: NotetakerFinalizeSessionPayload; options: TriggerOptions | undefined }[] = [];
  summaryCalls: { payload: NotetakerGenerateSummaryPayload; options: TriggerOptions | undefined }[] = [];
  notificationCalls: { payload: NotetakerSendNotificationPayload; options: TriggerOptions | undefined }[] =
    [];
  finalizeResult = { runId: "finalize-run" };
  notificationResult = { runId: "notification-run" };

  async finalizeSession(
    payload: NotetakerFinalizeSessionPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.finalizeCalls.push({ payload, options });
    return this.finalizeResult;
  }

  async generateSummary(
    payload: NotetakerGenerateSummaryPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.summaryCalls.push({ payload, options });
    return { runId: "summary-run" };
  }

  async sendNotification(
    payload: NotetakerSendNotificationPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.notificationCalls.push({ payload, options });
    return this.notificationResult;
  }
}

async function captureError(promise: Promise<unknown>): Promise<ErrorWithCode> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ErrorWithCode)) throw error;
    return error;
  }
  throw new Error("Expected the promise to reject");
}

describe("NotetakerDispatchService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let events: NotetakerBotEvent[];
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  let tasker: RecordingTasker;
  let users: NotetakerUserRecord[];
  const config: NotetakerConfig = getNotetakerConfig({});
  const NO_SHOW_MS = config.limits.noShowTimeoutSeconds * 1000;
  const HEARTBEAT_MS = config.limits.heartbeatTimeoutSeconds * 1000;

  const failedNotice = (bookingId: number, sessionId: string) => ({
    payload: { kind: "FAILED", bookingId, sessionId },
    options: { idempotencyKey: `notetaker:FAILED:${sessionId}` },
  });

  const eventSink = async (event: NotetakerBotEvent): Promise<void> => {
    events.push(event);
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    repositories = createInMemoryNotetakerRepositories();
    events = [];
    logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    tasker = new RecordingTasker();
    users = [
      { id: ORGANIZER_ID, name: ORGANIZER_NAME, email: ORGANIZER_EMAIL, locale: "en", timeZone: "UTC" },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function buildService(binding: NotetakerBotGatewayBinding | null): NotetakerDispatchService {
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) => users.filter((user) => ids.includes(user.id)),
    };
    return new NotetakerDispatchService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      sessionRepository: repositories.sessionRepository,
      activityRepository: repositories.activityRepository,
      botGatewayResolver: { resolve: () => binding },
      config,
      logger,
      accessService: new NotetakerAccessService({
        bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      }),
      userRepository,
      notetakerTasker: tasker,
    });
  }

  function fake(scenario: NotetakerFakeScenario = "manual"): FakeBotGateway {
    return new FakeBotGateway({ scenario, eventSink });
  }

  function fakeBinding(gateway: INotetakerBotGateway): NotetakerBotGatewayBinding {
    return { gateway, provider: "FAKE" };
  }

  function stopRecorder(overrides: Partial<INotetakerBotGateway> = {}): {
    gateway: INotetakerBotGateway;
    stopRequests: { sessionId: string; reason: NotetakerBotStopReason }[];
  } {
    const stopRequests: { sessionId: string; reason: NotetakerBotStopReason }[] = [];
    const gateway = createStubGateway({
      requestStop: async (input) => {
        stopRequests.push({ sessionId: input.sessionId, reason: input.reason });
      },
      ...overrides,
    });
    return { gateway, stopRequests };
  }

  async function settle(gateway: FakeBotGateway): Promise<void> {
    await gateway.whenIdle();
    expect(gateway.scriptErrors).toEqual([]);
  }

  async function arm(
    bookingId: number,
    overrides: { enabled?: boolean; pendingDispatch?: boolean; setAt?: Date } = {}
  ): Promise<void> {
    await repositories.bookingNotetakerRepository.upsert({
      bookingId,
      enabled: true,
      pendingDispatch: true,
      source: "HOST",
      appliedToSeries: false,
      setByUserId: ORGANIZER_ID,
      setAt: NOW,
      ...overrides,
    });
  }

  async function seedArmed(overrides: Partial<InMemoryBookingSeed> = {}): Promise<number> {
    const booking = buildBooking(overrides);
    repositories.store.addBooking(booking);
    await arm(booking.id);
    return booking.id;
  }

  // Enabled but not armed, so the dispatch and give-up steps leave the booking to the step under test.
  async function seedDispatched(overrides: Partial<InMemoryBookingSeed> = {}): Promise<number> {
    const booking = buildBooking(overrides);
    repositories.store.addBooking(booking);
    await arm(booking.id, { pendingDispatch: false });
    return booking.id;
  }

  async function seedSession(
    bookingId: number,
    status: "SCHEDULED" | "WAITING_TO_BE_ADMITTED" | "TRANSCRIBING" | "PROCESSING"
  ): Promise<string> {
    const session = await repositories.sessionRepository.create({
      bookingId,
      platform: "GOOGLE_MEET",
      meetingUrl: MEET_LINK,
      botProvider: "FAKE",
      displayName: "seeded",
      scheduledStartAt: START,
      status,
    });
    return session.id;
  }

  async function seedSessionWith(bookingId: number, patch: NotetakerSessionUpdateInput): Promise<string> {
    const sessionId = await seedSession(bookingId, "SCHEDULED");
    await repositories.sessionRepository.update(sessionId, patch);
    return sessionId;
  }

  function onlySession() {
    const sessions = Array.from(repositories.store.sessions.values());
    expect(sessions).toHaveLength(1);
    return sessions[0];
  }

  async function seedTranscribing(
    bookingId: number,
    patch: NotetakerSessionUpdateInput = {}
  ): Promise<string> {
    const sessionId = await seedSession(bookingId, "TRANSCRIBING");
    await repositories.sessionRepository.update(sessionId, { admittedAt: NOW, ...patch });
    return sessionId;
  }

  function hostStop(service: NotetakerDispatchService, userId: number = ORGANIZER_ID): Promise<void> {
    return service.stopForBooking({ bookingUid: BOOKING_UID, reason: "STOPPED_BY_HOST", userId });
  }

  function loggedText(): string {
    return JSON.stringify([
      logger.debug.mock.calls,
      logger.error.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
    ]);
  }

  describe("dispatchDue", () => {
    it("creates a SCHEDULED session and one join request for a due booking", async () => {
      const bookingId = await seedArmed();
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      const session = onlySession();
      expect(session).toMatchObject({
        bookingId,
        status: "SCHEDULED",
        platform: "GOOGLE_MEET",
        meetingUrl: MEET_LINK,
        botProvider: "FAKE",
        displayName: EXPECTED_DISPLAY_NAME,
        scheduledStartAt: START,
        dispatchedAt: NOW,
        startedLate: false,
        externalRef: `fake-ref-${session.id}`,
      });

      expect(gateway.joinRequests).toHaveLength(1);
      const request: NotetakerBotJoinRequest = gateway.joinRequests[0];
      expect(request).toMatchObject({
        sessionId: session.id,
        meetingUrl: MEET_LINK,
        scheduledStartAt: START.toISOString(),
        callbackUrl: `${WEBAPP_URL}/api/notetaker/events`,
        displayName: EXPECTED_DISPLAY_NAME,
        noticeMessage: EXPECTED_NOTICE,
        limits: {
          admissionTimeoutSeconds: config.limits.admissionTimeoutSeconds,
          noShowTimeoutSeconds: config.limits.noShowTimeoutSeconds,
          aloneTimeoutSeconds: config.limits.aloneTimeoutSeconds,
          maxDurationSeconds: config.limits.maxDurationSeconds,
        },
      });

      const choice = repositories.store.choices.get(bookingId);
      expect(choice?.pendingDispatch).toBe(false);
      expect(choice?.enabled).toBe(true);
    });

    it("resolves the meeting link at dispatch time, not when the choice was armed", async () => {
      await seedArmed();
      repositories.store.addBooking(
        buildBooking({ metadata: { videoCallUrl: "https://meet.google.com/new-link-xyz" } })
      );
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(gateway.joinRequests).toHaveLength(1);
      expect(gateway.joinRequests[0].meetingUrl).toBe("https://meet.google.com/new-link-xyz");
      expect(onlySession().meetingUrl).toBe("https://meet.google.com/new-link-xyz");
    });

    it("emits session.join_requested first when the happy scenario plays", async () => {
      await seedArmed();
      const gateway = fake("happy");

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      const session = onlySession();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("session.join_requested");
      for (const event of events) {
        expect(event.sessionId).toBe(session.id);
      }
    });

    it("dispatches a booking that starts exactly at the end of the join lead", async () => {
      await seedArmed({ startTime: offsetFromNow(config.limits.joinLeadSeconds * 1000) });
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(repositories.store.sessions.size).toBe(1);
      expect(gateway.joinRequests).toHaveLength(1);
    });

    const skippedCases: {
      name: string;
      booking?: Partial<InMemoryBookingSeed>;
      choice?: { enabled?: boolean; pendingDispatch?: boolean };
      noChoice?: boolean;
    }[] = [
      { name: "starts one second after the join lead", booking: { startTime: offsetFromNow(121_000) } },
      { name: "is PENDING", booking: { status: "PENDING" } },
      { name: "is CANCELLED", booking: { status: "CANCELLED" } },
      { name: "ends exactly now", booking: { endTime: NOW } },
      { name: "is not pending dispatch", choice: { pendingDispatch: false } },
      { name: "is not enabled", choice: { enabled: false } },
      { name: "has no choice", noChoice: true },
    ];

    it.each(skippedCases)("skips a booking that $name", async ({ booking, choice, noChoice }) => {
      const seed = buildBooking(booking);
      repositories.store.addBooking(seed);
      if (!noChoice) await arm(seed.id, choice);
      const before = repositories.store.choices.get(seed.id);
      const choiceBefore = before ? { ...before } : undefined;
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(repositories.store.sessions.size).toBe(0);
      expect(gateway.joinRequests).toHaveLength(0);
      expect(repositories.store.choices.get(seed.id)).toEqual(choiceBefore);
    });

    it.each(
      Array.from(NOTETAKER_LIVE_SESSION_STATUSES)
    )("does not dispatch again while a %s session exists and leaves the choice armed", async (status) => {
      const bookingId = await seedArmed();
      await seedSession(bookingId, status);
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(repositories.store.sessions.size).toBe(1);
      expect(gateway.joinRequests).toHaveLength(0);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
    });

    it("has the session row in place, without externalRef, before the gateway is called", async () => {
      await seedArmed();
      const observations: Awaited<ReturnType<typeof repositories.sessionRepository.findById>>[] = [];
      const gateway = createStubGateway({
        requestJoin: async (input) => {
          observations.push(await repositories.sessionRepository.findById(input.sessionId));
          return { externalRef: "stub-ref" };
        },
      });

      await buildService(fakeBinding(gateway)).dispatchDue();

      expect(observations).toHaveLength(1);
      expect(observations[0]?.status).toBe("SCHEDULED");
      expect(observations[0]?.externalRef).toBeNull();
      expect(onlySession().externalRef).toBe("stub-ref");
    });

    it.each([
      { name: "more than 60 seconds after the start", nowOffsetFromStartMs: 61_000, expected: true },
      { name: "exactly 60 seconds after the start", nowOffsetFromStartMs: 60_000, expected: false },
      { name: "before the start", nowOffsetFromStartMs: -60_000, expected: false },
    ])("sets startedLate for a dispatch $name", async ({ nowOffsetFromStartMs, expected }) => {
      await seedArmed();
      vi.setSystemTime(new Date(START.getTime() + nowOffsetFromStartMs));
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(onlySession().startedLate).toBe(expected);
    });

    it("marks the session FAILED and does not re-arm when the bot reports the link unusable", async () => {
      const bookingId = await seedArmed();
      const gateway = fake("link_unusable");

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(gateway.joinRequests).toHaveLength(1);
      expect(onlySession()).toMatchObject({
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        endedAt: NOW,
        externalRef: null,
      });
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    it("deletes the session and re-arms the choice on a TRANSIENT gateway failure", async () => {
      const bookingId = await seedArmed();

      await buildService(fakeBinding(createTransientGateway())).dispatchDue();

      expect(repositories.store.sessions.size).toBe(0);
      const choice = repositories.store.choices.get(bookingId);
      expect(choice?.pendingDispatch).toBe(true);
      expect(choice?.enabled).toBe(true);
    });

    it("treats an unclassified gateway error like a transient one", async () => {
      const bookingId = await seedArmed();
      const gateway = createStubGateway({
        requestJoin: async () => {
          throw new Error("boom");
        },
      });

      await buildService(fakeBinding(gateway)).dispatchDue();

      expect(repositories.store.sessions.size).toBe(0);
      const choice = repositories.store.choices.get(bookingId);
      expect(choice?.pendingDispatch).toBe(true);
      expect(choice?.enabled).toBe(true);
    });

    it("records a FAILED session without calling the bot when a supported type has no link", async () => {
      const bookingId = await seedArmed({ location: MeetLocationType, references: [], metadata: null });
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(gateway.joinRequests).toHaveLength(0);
      expect(onlySession()).toMatchObject({
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        meetingUrl: "",
        platform: "GOOGLE_MEET",
        endedAt: NOW,
      });
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    it.each([
      "integrations:zoom",
      "123 Main St",
      "integrations:daily",
      "https://teams.microsoft.com/l/meetup-join/x",
    ])("disables the choice and logs UNSUPPORTED_LOCATION for location %s", async (location) => {
      const bookingId = await seedArmed({ location });
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(repositories.store.sessions.size).toBe(0);
      expect(gateway.joinRequests).toHaveLength(0);
      const choice = repositories.store.choices.get(bookingId);
      expect(choice?.enabled).toBe(false);
      expect(choice?.pendingDispatch).toBe(false);
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId,
        sessionId: null,
        action: "DISABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        detail: { reason: "UNSUPPORTED_LOCATION" },
      });
    });

    it("dispatches at most one batch, earliest starts first", async () => {
      expect(NOTETAKER_SWEEP_BATCH_SIZE).toBe(200);
      const total = NOTETAKER_SWEEP_BATCH_SIZE + 1;
      for (let id = 1; id <= total; id += 1) {
        // Descending start by id, so booking 1 is the latest and falls outside the batch.
        const startTime = offsetFromNow((total - id) * 100);
        repositories.store.addBooking(
          buildBooking({
            id,
            uid: `uid-${id}`,
            startTime,
            endTime: new Date(startTime.getTime() + 1_800_000),
          })
        );
        await arm(id);
      }
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(gateway.joinRequests).toHaveLength(NOTETAKER_SWEEP_BATCH_SIZE);
      const starts = gateway.joinRequests.map((request) => Date.parse(request.scheduledStartAt));
      for (let i = 1; i < starts.length; i += 1) {
        expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
      }
      expect(repositories.store.choices.get(1)?.pendingDispatch).toBe(true);
      const sessionsOfFirst = Array.from(repositories.store.sessions.values()).filter(
        (session) => session.bookingId === 1
      );
      expect(sessionsOfFirst).toHaveLength(0);
    });

    it("renders the display name and the notice in the organizer's locale", async () => {
      await seedArmed({
        organizer: { id: ORGANIZER_ID, name: "Jana", email: ORGANIZER_EMAIL, locale: "de" },
      });
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      const displayName = `de:notetaker_display_name:${JSON.stringify({ appName: APP_NAME, hostName: "Jana" })}`;
      expect(gateway.joinRequests).toHaveLength(1);
      expect(gateway.joinRequests[0].displayName).toBe(displayName);
      expect(gateway.joinRequests[0].noticeMessage).toBe(
        `de:notetaker_meeting_notice:${JSON.stringify({ hostName: "Jana" })}`
      );
      expect(onlySession().displayName).toBe(displayName);
    });

    const hostNameCases: { name: string; organizer: InMemoryBookingSeed["organizer"]; hostName: string }[] = [
      {
        name: "the app name when the organizer has no name",
        organizer: { id: ORGANIZER_ID, name: null, email: ORGANIZER_EMAIL, locale: "en" },
        hostName: APP_NAME,
      },
      { name: "the app name when the booking has no organizer", organizer: null, hostName: APP_NAME },
      {
        name: "the app name when the organizer's name is empty",
        organizer: { id: ORGANIZER_ID, name: "", email: ORGANIZER_EMAIL, locale: "en" },
        hostName: APP_NAME,
      },
      {
        name: "the app name when the organizer's name is only whitespace",
        organizer: { id: ORGANIZER_ID, name: "   ", email: ORGANIZER_EMAIL, locale: "en" },
        hostName: APP_NAME,
      },
      {
        name: "the trimmed name when the organizer's name has surrounding whitespace",
        organizer: { id: ORGANIZER_ID, name: "  Jana  ", email: ORGANIZER_EMAIL, locale: "en" },
        hostName: "Jana",
      },
    ];

    it.each(hostNameCases)("uses $name as the host name", async ({ organizer, hostName }) => {
      await seedArmed({ organizer });
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      const displayName = `en:notetaker_display_name:${JSON.stringify({ appName: APP_NAME, hostName })}`;
      expect(gateway.joinRequests).toHaveLength(1);
      expect(gateway.joinRequests[0].displayName).toBe(displayName);
      expect(gateway.joinRequests[0].noticeMessage).toBe(
        `en:notetaker_meeting_notice:${JSON.stringify({ hostName })}`
      );
      expect(onlySession().displayName).toBe(displayName);
    });

    it("enqueues one delayed attendee notice after an accepted join", async () => {
      const bookingId = await seedArmed();
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchDue();
      await settle(gateway);

      expect(tasker.notificationCalls).toEqual([
        {
          payload: { kind: "ATTENDEE_NOTICE", bookingId, sessionId: onlySession().id },
          options: { delay: "30s" },
        },
      ]);
      expect(tasker.finalizeCalls).toEqual([]);
    });

    it("enqueues the attendee notice only after externalRef is stored", async () => {
      await seedArmed();
      const externalRefsAtEnqueue: (string | null)[] = [];
      class ObservingTasker extends RecordingTasker {
        async sendNotification(
          payload: NotetakerSendNotificationPayload,
          options?: TriggerOptions
        ): Promise<{ runId: string }> {
          const session =
            payload.sessionId === null
              ? null
              : await repositories.sessionRepository.findById(payload.sessionId);
          externalRefsAtEnqueue.push(session?.externalRef ?? null);
          return super.sendNotification(payload, options);
        }
      }
      tasker = new ObservingTasker();

      await buildService(fakeBinding(createStubGateway())).dispatchDue();

      expect(externalRefsAtEnqueue).toEqual([`stub-ref-${onlySession().id}`]);
    });

    const noNoticeCases: {
      name: string;
      booking?: Partial<InMemoryBookingSeed>;
      choice?: { enabled?: boolean; pendingDispatch?: boolean };
      liveSession?: boolean;
      gateway: () => INotetakerBotGateway | null;
    }[] = [
      {
        name: "the location is unsupported",
        booking: { location: "integrations:zoom" },
        gateway: () => fake(),
      },
      {
        name: "a supported type has no link",
        booking: { location: MeetLocationType, references: [], metadata: null },
        gateway: () => fake(),
      },
      { name: "the bot reports the link unusable", gateway: () => fake("link_unusable") },
      { name: "the join request fails transiently", gateway: () => createTransientGateway() },
      {
        name: "the join request fails with an unclassified error",
        gateway: () =>
          createStubGateway({
            requestJoin: async () => {
              throw new Error("boom");
            },
          }),
      },
      { name: "the provider is unusable", gateway: () => null },
      { name: "a live session already exists", liveSession: true, gateway: () => fake() },
      { name: "the choice is not armed", choice: { pendingDispatch: false }, gateway: () => fake() },
    ];

    it.each(noNoticeCases)("does not enqueue an attendee notice when $name", async (testCase) => {
      const seed = buildBooking(testCase.booking);
      repositories.store.addBooking(seed);
      await arm(seed.id, testCase.choice);
      if (testCase.liveSession) await seedSession(seed.id, "SCHEDULED");
      const gateway = testCase.gateway();

      await buildService(gateway ? fakeBinding(gateway) : null).dispatchDue();
      if (gateway instanceof FakeBotGateway) await settle(gateway);

      expect(tasker.notificationCalls.filter((call) => call.payload.kind === "ATTENDEE_NOTICE")).toEqual([]);
    });

    it("does not enqueue a notice when storing externalRef fails", async () => {
      await seedArmed();
      vi.spyOn(repositories.sessionRepository, "update").mockRejectedValueOnce(new Error("db down"));

      await expect(buildService(fakeBinding(createStubGateway())).dispatchDue()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(tasker.notificationCalls).toEqual([]);
    });

    describe("isolation between bookings", () => {
      async function seedTwoDue(): Promise<{ first: number; second: number }> {
        const first = await seedArmed({ id: 1, uid: "uid-1", startTime: offsetFromNow(10_000) });
        const second = await seedArmed({ id: 2, uid: "uid-2", startTime: offsetFromNow(20_000) });
        return { first, second };
      }

      it("still dispatches the second booking when the first one's gateway call fails", async () => {
        const { first, second } = await seedTwoDue();
        let calls = 0;
        const gateway = createStubGateway({
          requestJoin: async (input) => {
            calls += 1;
            if (calls === 1) throw new Error("boom");
            return { externalRef: `stub-ref-${input.sessionId}` };
          },
        });

        await buildService(fakeBinding(gateway)).dispatchDue();

        const sessions = Array.from(repositories.store.sessions.values());
        expect(sessions).toHaveLength(1);
        expect(sessions[0].bookingId).toBe(second);
        expect(repositories.store.choices.get(first)?.pendingDispatch).toBe(true);
        expect(logger.error).not.toHaveBeenCalled();
      });

      it("still dispatches the second booking, logs once and re-arms the first when create rejects", async () => {
        const { first, second } = await seedTwoDue();
        vi.spyOn(repositories.sessionRepository, "create").mockRejectedValueOnce(new Error("db down"));
        const gateway = fake();

        await buildService(fakeBinding(gateway)).dispatchDue();
        await settle(gateway);

        const sessions = Array.from(repositories.store.sessions.values());
        expect(sessions).toHaveLength(1);
        expect(sessions[0].bookingId).toBe(second);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(repositories.store.choices.get(first)?.pendingDispatch).toBe(true);
      });

      it("enqueues a notice for every due booking, each with its own session", async () => {
        const { first, second } = await seedTwoDue();
        const gateway = fake();

        await buildService(fakeBinding(gateway)).dispatchDue();
        await settle(gateway);

        const sessions = Array.from(repositories.store.sessions.values());
        expect(sessions).toHaveLength(2);
        const expected = [first, second].map((bookingId) => ({
          payload: {
            kind: "ATTENDEE_NOTICE",
            bookingId,
            sessionId: sessions.find((session) => session.bookingId === bookingId)?.id,
          },
          options: { delay: "30s" },
        }));
        expect(tasker.notificationCalls).toEqual(expected);
      });

      it("still dispatches the second booking when the first one's notice cannot be enqueued", async () => {
        await seedTwoDue();
        tasker.notificationResult = { runId: "task-failed" };
        const gateway = fake();

        await buildService(fakeBinding(gateway)).dispatchDue();
        await settle(gateway);

        expect(repositories.store.sessions.size).toBe(2);
        expect(gateway.joinRequests).toHaveLength(2);
        expect(logger.error).toHaveBeenCalledTimes(2);
      });
    });

    it("logs one error and writes nothing when the provider is unusable", async () => {
      const bookingId = await seedArmed();

      await buildService(null).dispatchDue();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(repositories.store.sessions.size).toBe(0);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
    });
  });

  describe("getNotetakerGiveUpDeadline", () => {
    const at = (time: string): Date => new Date(`2026-10-12T${time}:00.000Z`);

    it.each([
      {
        name: "the no-show timeout after the start when the choice was set before it",
        times: { startTime: at("10:00"), endTime: at("10:30"), setAt: at("09:59") },
        expected: at("10:15"),
      },
      {
        name: "the no-show timeout after the choice when it was set after the start",
        times: { startTime: at("10:00"), endTime: at("10:30"), setAt: at("10:05") },
        expected: at("10:20"),
      },
      {
        name: "the end of the booking when it comes before the timeout",
        times: { startTime: at("10:00"), endTime: at("10:10"), setAt: at("09:59") },
        expected: at("10:10"),
      },
      {
        name: "the end of the booking when the choice was set after it",
        times: { startTime: at("10:00"), endTime: at("10:30"), setAt: at("10:45") },
        expected: at("10:30"),
      },
    ])("is $name", ({ times, expected }) => {
      expect(getNotetakerGiveUpDeadline({ ...times, noShowTimeoutSeconds: 900 })).toEqual(expected);
    });
  });

  describe("dispatchDue: FAILED notices at dispatch", () => {
    const NO_LINK: Partial<InMemoryBookingSeed> = {
      location: MeetLocationType,
      references: [],
      metadata: null,
    };

    function linkUnusableGateway(): INotetakerBotGateway {
      return createStubGateway({
        requestJoin: async () => {
          throw createNotetakerBotGatewayError("LINK_UNUSABLE", "unusable");
        },
      });
    }

    it("enqueues one keyed FAILED notice when the bot reports the link unusable", async () => {
      const bookingId = await seedArmed();

      await buildService(fakeBinding(linkUnusableGateway())).dispatchDue();

      const session = onlySession();
      expect(session).toMatchObject({
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        endedAt: NOW,
      });
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, session.id)]);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    it("enqueues one keyed FAILED notice when a supported type has no link", async () => {
      const bookingId = await seedArmed(NO_LINK);
      const requestJoin = vi.fn();

      await buildService(fakeBinding(createStubGateway({ requestJoin }))).dispatchDue();

      expect(requestJoin).not.toHaveBeenCalled();
      const session = onlySession();
      expect(session).toMatchObject({
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        meetingUrl: "",
      });
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, session.id)]);
    });

    it("enqueues the same notice when dispatchForBooking hits an unusable link", async () => {
      const bookingId = await seedArmed();

      await buildService(fakeBinding(linkUnusableGateway())).dispatchForBooking({ bookingUid: BOOKING_UID });

      const session = onlySession();
      expect(session).toMatchObject({ status: "FAILED", outcomeReason: "MEETING_LINK_UNUSABLE" });
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, session.id)]);
    });

    it("enqueues nothing when the FAILED transition loses the race", async () => {
      await seedArmed();
      vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

      await buildService(fakeBinding(linkUnusableGateway())).dispatchDue();

      expect(tasker.notificationCalls).toEqual([]);
    });

    it.each([
      { name: "the bot reports the link unusable", booking: {}, gateway: linkUnusableGateway },
      { name: "a supported type has no link", booking: NO_LINK, gateway: createStubGateway },
    ])("logs and keeps the FAILED session when the notice cannot be enqueued and $name", async (testCase) => {
      const bookingId = await seedArmed(testCase.booking);
      tasker.notificationResult = { runId: "task-failed" };

      await expect(buildService(fakeBinding(testCase.gateway())).dispatchDue()).resolves.toBeUndefined();

      const session = onlySession();
      expect(session.status).toBe("FAILED");
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ bookingId, sessionId: session.id })
      );
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    it("enqueues no FAILED notice for an unsupported location", async () => {
      await seedArmed({ location: "integrations:zoom" });

      await buildService(fakeBinding(createStubGateway())).dispatchDue();

      expect(tasker.notificationCalls).toEqual([]);
    });
  });

  describe("dispatchDue: give-up", () => {
    const SET_AFTER_START = new Date(START.getTime() + 300_000);
    const EARLY_END = new Date(START.getTime() + 600_000);

    const deadlineBranches: { name: string; seed: () => Promise<number>; deadline: Date }[] = [
      {
        name: "the choice was set before the start",
        seed: () => seedArmed(),
        deadline: new Date(START.getTime() + NO_SHOW_MS),
      },
      {
        name: "the choice was set after the start",
        seed: async () => {
          const booking = buildBooking();
          repositories.store.addBooking(booking);
          await arm(booking.id, { setAt: SET_AFTER_START });
          return booking.id;
        },
        deadline: new Date(SET_AFTER_START.getTime() + NO_SHOW_MS),
      },
      {
        name: "the booking ends before the no-show timeout",
        seed: () => seedArmed({ endTime: EARLY_END }),
        deadline: EARLY_END,
      },
    ];

    function giveUp(gateway: INotetakerBotGateway = createTransientGateway()): Promise<void> {
      return buildService(fakeBinding(gateway)).dispatchDue();
    }

    it.each(deadlineBranches)("records a FAILED session at exactly the deadline when $name", async ({
      seed,
      deadline,
    }) => {
      const bookingId = await seed();
      vi.setSystemTime(deadline);

      await giveUp();

      const session = onlySession();
      expect(session).toMatchObject({
        bookingId,
        status: "FAILED",
        outcomeReason: "INTERRUPTED",
        platform: "GOOGLE_MEET",
        meetingUrl: MEET_LINK,
        botProvider: "FAKE",
        displayName: EXPECTED_DISPLAY_NAME,
        scheduledStartAt: START,
        dispatchedAt: deadline,
        endedAt: deadline,
        externalRef: null,
        startedLate: true,
      });
      const choice = repositories.store.choices.get(bookingId);
      expect(choice?.pendingDispatch).toBe(false);
      expect(choice?.enabled).toBe(true);
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, session.id)]);
      expect(repositories.store.activities).toEqual([]);
    });

    it.each(deadlineBranches)("keeps retrying one second before the deadline when $name", async ({
      seed,
      deadline,
    }) => {
      const bookingId = await seed();
      vi.setSystemTime(new Date(deadline.getTime() - 1000));

      await giveUp();

      expect(repositories.store.sessions.size).toBe(0);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
      expect(tasker.notificationCalls).toEqual([]);
    });

    it("gives up in the same run as the last transient join failure", async () => {
      const bookingId = await seedArmed();
      const service = buildService(fakeBinding(createTransientGateway()));

      await service.dispatchDue();

      expect(repositories.store.sessions.size).toBe(0);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);

      vi.setSystemTime(new Date(START.getTime() + NO_SHOW_MS));
      await service.dispatchDue();

      const session = onlySession();
      expect(session).toMatchObject({ status: "FAILED", outcomeReason: "INTERRUPTED" });
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, session.id)]);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("sends no join request once the booking has ended", async () => {
      await seedArmed();
      vi.setSystemTime(END);
      const requestJoin = vi.fn();

      await giveUp(createStubGateway({ requestJoin }));

      expect(requestJoin).not.toHaveBeenCalled();
      expect(onlySession()).toMatchObject({ status: "FAILED", outcomeReason: "INTERRUPTED" });
    });

    it("leaves a booking with a live session armed", async () => {
      // The clock moves first so the seeded session's dispatchedAt is fresh for the watchdog.
      vi.setSystemTime(new Date(START.getTime() + NO_SHOW_MS));
      const bookingId = await seedArmed();
      await seedSession(bookingId, "SCHEDULED");

      await giveUp();

      expect(onlySession().status).toBe("SCHEDULED");
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
      expect(tasker.notificationCalls).toEqual([]);
    });

    it("creates no session when clearPendingDispatch loses", async () => {
      await seedArmed();
      vi.setSystemTime(END);
      vi.spyOn(repositories.bookingNotetakerRepository, "clearPendingDispatch").mockResolvedValueOnce(false);

      await giveUp();

      expect(repositories.store.sessions.size).toBe(0);
      expect(tasker.notificationCalls).toEqual([]);
    });

    it("creates one session and one notice when two runs overlap", async () => {
      const bookingId = await seedArmed();
      vi.setSystemTime(END);
      const service = buildService(fakeBinding(createTransientGateway()));

      await Promise.all([service.dispatchDue(), service.dispatchDue()]);

      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, onlySession().id)]);
    });

    it("changes nothing on a second run at the same clock", async () => {
      const bookingId = await seedArmed();
      vi.setSystemTime(END);
      const service = buildService(fakeBinding(createTransientGateway()));
      await service.dispatchDue();
      const snapshot = { ...onlySession() };

      await service.dispatchDue();

      expect(onlySession()).toEqual(snapshot);
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, snapshot.id)]);
    });

    it("disables the choice instead of creating a session for an unsupported location", async () => {
      const bookingId = await seedArmed({ location: "integrations:zoom" });
      vi.setSystemTime(END);

      await giveUp();

      expect(repositories.store.sessions.size).toBe(0);
      const choice = repositories.store.choices.get(bookingId);
      expect(choice?.enabled).toBe(false);
      expect(choice?.pendingDispatch).toBe(false);
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId,
        action: "DISABLED",
        actorType: "SYSTEM",
        detail: { reason: "UNSUPPORTED_LOCATION" },
      });
      expect(tasker.notificationCalls).toEqual([]);
    });

    it("records the session with an empty link when a supported type has none", async () => {
      const bookingId = await seedArmed({ location: MeetLocationType, references: [], metadata: null });
      vi.setSystemTime(END);

      await giveUp();

      const session = onlySession();
      expect(session).toMatchObject({
        status: "FAILED",
        outcomeReason: "INTERRUPTED",
        meetingUrl: "",
        platform: "GOOGLE_MEET",
      });
      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, session.id)]);
    });

    it("re-arms the choice when the session cannot be created, so the next run gives up", async () => {
      const bookingId = await seedArmed();
      vi.setSystemTime(END);
      vi.spyOn(repositories.sessionRepository, "create").mockRejectedValueOnce(new Error("db down"));
      const service = buildService(fakeBinding(createTransientGateway()));

      await expect(service.dispatchDue()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ bookingId }));
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
      expect(repositories.store.sessions.size).toBe(0);

      await service.dispatchDue();

      expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, onlySession().id)]);
    });

    it("logs and keeps the FAILED session when the notice cannot be enqueued", async () => {
      const bookingId = await seedArmed();
      vi.setSystemTime(END);
      tasker.notificationResult = { runId: "task-failed" };

      await expect(giveUp()).resolves.toBeUndefined();

      const session = onlySession();
      expect(session.status).toBe("FAILED");
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ bookingId, sessionId: session.id })
      );
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    const nonCandidates: {
      name: string;
      booking?: Partial<InMemoryBookingSeed>;
      choice?: { enabled?: boolean; pendingDispatch?: boolean };
    }[] = [
      { name: "is not pending dispatch", choice: { pendingDispatch: false } },
      { name: "is not enabled", choice: { enabled: false } },
      { name: "is CANCELLED", booking: { status: "CANCELLED" } },
      {
        name: "is PENDING and has not started",
        booking: {
          status: "PENDING",
          startTime: new Date(END.getTime() + 1000),
          endTime: new Date(END.getTime() + 1_800_000),
        },
      },
    ];

    it.each(nonCandidates)("does not give up on a booking that $name", async ({ booking, choice }) => {
      const seed = buildBooking(booking);
      repositories.store.addBooking(seed);
      await arm(seed.id, choice);
      vi.setSystemTime(END);

      await giveUp();

      expect(repositories.store.sessions.size).toBe(0);
      expect(tasker.notificationCalls).toEqual([]);
    });
  });

  describe("dispatchDue: voiding unconfirmed bookings", () => {
    const UNCONFIRMED: InMemoryBookingSeed["status"][] = ["PENDING", "AWAITING_HOST"];

    it.each(UNCONFIRMED)("turns the choice off for a %s booking that starts now", async (status) => {
      const booking = buildBooking({ status, startTime: NOW });
      repositories.store.addBooking(booking);
      await arm(booking.id);
      await repositories.bookingNotetakerRepository.setRejoinBlocked(booking.id, true);
      await repositories.bookingNotetakerRepository.appendNotifiedAttendeeEmails(
        booking.id,
        ["a@example.com"],
        NOW
      );
      const before = await repositories.bookingNotetakerRepository.findByBookingId(booking.id);
      const requestJoin = vi.fn();
      const { gateway, stopRequests } = stopRecorder({ requestJoin });

      await buildService(fakeBinding(gateway)).dispatchDue();

      expect(repositories.store.choices.get(booking.id)).toEqual({
        ...before,
        enabled: false,
        pendingDispatch: false,
      });
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId: booking.id,
        sessionId: null,
        action: "DISABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        actorName: null,
        detail: { reason: "BOOKING_NOT_CONFIRMED" },
      });
      expect(repositories.store.sessions.size).toBe(0);
      expect(tasker.notificationCalls).toEqual([]);
      expect(tasker.finalizeCalls).toEqual([]);
      expect(requestJoin).not.toHaveBeenCalled();
      expect(stopRequests).toEqual([]);
    });

    it.each(UNCONFIRMED)("leaves a %s booking that starts in one second alone", async (status) => {
      const bookingId = await seedArmed({ status, startTime: offsetFromNow(1000) });
      const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);

      await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

      expect(repositories.store.choices.get(bookingId)).toEqual(before);
      expect(repositories.store.activities).toEqual([]);
    });

    it("turns off a choice that is enabled but no longer armed", async () => {
      const bookingId = await seedDispatched({ status: "PENDING", startTime: NOW });

      await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

      expect(repositories.store.choices.get(bookingId)?.enabled).toBe(false);
      expect(repositories.store.activities).toHaveLength(1);
    });

    it.each<InMemoryBookingSeed["status"]>([
      "CANCELLED",
      "REJECTED",
    ])("does not write to a %s booking without a session", async (status) => {
      const bookingId = await seedArmed({ status, startTime: NOW });
      const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);

      await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

      expect(repositories.store.choices.get(bookingId)).toEqual(before);
      expect(repositories.store.activities).toEqual([]);
      expect(repositories.store.sessions.size).toBe(0);
    });

    it("writes one activity over two runs", async () => {
      await seedArmed({ status: "PENDING", startTime: NOW });
      const service = buildService(fakeBinding(stopRecorder().gateway));

      await service.dispatchDue();
      await service.dispatchDue();

      expect(repositories.store.activities).toHaveLength(1);
    });

    it("writes one activity when two runs overlap", async () => {
      await seedArmed({ status: "PENDING", startTime: NOW });
      const service = buildService(fakeBinding(stopRecorder().gateway));

      await Promise.all([service.dispatchDue(), service.dispatchDue()]);

      expect(repositories.store.activities).toHaveLength(1);
    });

    it("still voids the second booking when the first one's activity cannot be written", async () => {
      const first = await seedArmed({
        id: 1,
        uid: "uid-1",
        status: "PENDING",
        startTime: offsetFromNow(-2000),
      });
      const second = await seedArmed({
        id: 2,
        uid: "uid-2",
        status: "PENDING",
        startTime: offsetFromNow(-1000),
      });
      vi.spyOn(repositories.activityRepository, "create").mockRejectedValueOnce(new Error("db down"));

      await expect(buildService(fakeBinding(stopRecorder().gateway)).dispatchDue()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ bookingId: first })
      );
      expect(repositories.store.choices.get(second)?.enabled).toBe(false);
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId: second,
        detail: { reason: "BOOKING_NOT_CONFIRMED" },
      });
    });

    it("voids at most one batch, earliest starts first", async () => {
      const total = NOTETAKER_SWEEP_BATCH_SIZE + 1;
      for (let id = 1; id <= total; id += 1) {
        // Descending start by id, so booking 1 is the latest and falls outside the batch.
        const startTime = offsetFromNow(-(id - 1) * 100);
        repositories.store.addBooking(
          buildBooking({
            id,
            uid: `uid-${id}`,
            status: "PENDING",
            startTime,
            endTime: new Date(startTime.getTime() + 1_800_000),
          })
        );
        await arm(id);
      }

      await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

      const disabled = Array.from(repositories.store.choices.values()).filter((choice) => !choice.enabled);
      expect(disabled).toHaveLength(NOTETAKER_SWEEP_BATCH_SIZE);
      expect(repositories.store.activities).toHaveLength(NOTETAKER_SWEEP_BATCH_SIZE);
      expect(repositories.store.choices.get(1)?.enabled).toBe(true);
    });
  });

  describe("dispatchDue: watchdog", () => {
    type PreAdmissionStatus = "SCHEDULED" | "WAITING_TO_BE_ADMITTED";

    const PRE_ADMISSION: PreAdmissionStatus[] = ["SCHEDULED", "WAITING_TO_BE_ADMITTED"];
    const AT_TIMEOUT = new Date(NOW.getTime() + HEARTBEAT_MS);
    const INSIDE_TIMEOUT = new Date(NOW.getTime() + HEARTBEAT_MS - 1000);

    const finalizeKey = (sessionId: string) => ({
      payload: { sessionId },
      options: { idempotencyKey: `notetaker:finalize:${sessionId}` },
    });

    function failingStop(): INotetakerBotGateway {
      return stopRecorder({
        requestStop: async () => {
          throw new Error("bot down");
        },
      }).gateway;
    }

    // TRANSCRIBING is seeded with admittedAt, which is what the watchdog reads as "after admission".
    function seedLive(bookingId: number, status: PreAdmissionStatus | "TRANSCRIBING"): Promise<string> {
      if (status === "TRANSCRIBING") return seedTranscribing(bookingId);
      return seedSession(bookingId, status);
    }

    function setBookingStatus(status: InMemoryBookingSeed["status"]): void {
      repositories.store.addBooking(buildBooking({ status }));
    }

    describe("when the booking is no longer ACCEPTED", () => {
      const notActiveCases: {
        bookingStatus: InMemoryBookingSeed["status"];
        sessionStatus: PreAdmissionStatus;
      }[] = [
        { bookingStatus: "CANCELLED", sessionStatus: "SCHEDULED" },
        { bookingStatus: "CANCELLED", sessionStatus: "WAITING_TO_BE_ADMITTED" },
        { bookingStatus: "REJECTED", sessionStatus: "SCHEDULED" },
        { bookingStatus: "REJECTED", sessionStatus: "WAITING_TO_BE_ADMITTED" },
        { bookingStatus: "PENDING", sessionStatus: "SCHEDULED" },
        { bookingStatus: "PENDING", sessionStatus: "WAITING_TO_BE_ADMITTED" },
      ];

      it.each(
        notActiveCases
      )("stops and deletes a $sessionStatus session and voids the choice of a $bookingStatus booking", async ({
        bookingStatus,
        sessionStatus,
      }) => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSession(bookingId, sessionStatus);
        setBookingStatus(bookingStatus);
        const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(stopRequests).toEqual([{ sessionId, reason: "BOOKING_NOT_ACTIVE" }]);
        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.choices.get(bookingId)).toEqual({
          ...before,
          enabled: false,
          pendingDispatch: false,
        });
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject({
          bookingId,
          sessionId: null,
          action: "DISABLED",
          actorType: "SYSTEM",
          detail: { reason: "BOOKING_NOT_ACTIVE" },
        });
        expect(tasker.notificationCalls).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("deletes the row and voids the choice even when the bot cannot be reached", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        setBookingStatus("CANCELLED");

        await buildService(fakeBinding(failingStop())).dispatchDue();

        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.choices.get(bookingId)?.enabled).toBe(false);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId }));
      });

      it("writes no activity when the choice is already off", async () => {
        const bookingId = await seedDispatched();
        await arm(bookingId, { enabled: false, pendingDispatch: false });
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        setBookingStatus("CANCELLED");

        await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toEqual([]);
      });

      it("records only BOOKING_NOT_CONFIRMED for a started PENDING booking with a session", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        repositories.store.addBooking(buildBooking({ status: "PENDING", startTime: NOW }));

        await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject({
          bookingId,
          detail: { reason: "BOOKING_NOT_CONFIRMED" },
        });
      });

      it("only requests the stop after admission while the heartbeat is fresh", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedTranscribing(bookingId);
        setBookingStatus("CANCELLED");
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);
        const { gateway, stopRequests } = stopRecorder();
        const service = buildService(fakeBinding(gateway));

        await service.dispatchDue();

        expect(stopRequests).toEqual([{ sessionId, reason: "BOOKING_NOT_ACTIVE" }]);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(repositories.store.choices.get(bookingId)).toEqual(before);
        expect(repositories.store.activities).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
        expect(tasker.notificationCalls).toEqual([]);

        await service.dispatchDue();

        expect(stopRequests).toHaveLength(2);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(repositories.store.choices.get(bookingId)).toEqual(before);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("also finalizes after admission once the heartbeat is lost", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedTranscribing(bookingId);
        setBookingStatus("CANCELLED");
        const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);
        vi.setSystemTime(AT_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(stopRequests).toEqual([
          { sessionId, reason: "BOOKING_NOT_ACTIVE" },
          { sessionId, reason: "DISABLED" },
        ]);
        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "PROCESSING",
          outcomeReason: "INTERRUPTED",
          endedAt: AT_TIMEOUT,
          interruptedAtMs: null,
        });
        expect(tasker.finalizeCalls).toEqual([{ payload: { sessionId }, options: undefined }]);
        expect(repositories.store.choices.get(bookingId)).toEqual(before);
        expect(tasker.notificationCalls).toEqual([]);
      });
    });

    describe("when the heartbeat is lost", () => {
      it.each(
        PRE_ADMISSION
      )("fails a %s session at exactly the timeout and enqueues a FAILED notice", async (status) => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSession(bookingId, status);
        const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);
        vi.setSystemTime(AT_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(stopRequests).toEqual([{ sessionId, reason: "DISABLED" }]);
        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "FAILED",
          outcomeReason: "INTERRUPTED",
          endedAt: AT_TIMEOUT,
        });
        expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, sessionId)]);
        expect(tasker.finalizeCalls).toEqual([]);
        expect(repositories.store.choices.get(bookingId)).toEqual(before);
        expect(repositories.store.activities).toEqual([]);
      });

      it("moves an admitted session to PROCESSING at exactly the timeout and enqueues one finalize", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedTranscribing(bookingId);
        vi.setSystemTime(AT_TIMEOUT);

        await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "PROCESSING",
          outcomeReason: "INTERRUPTED",
          endedAt: AT_TIMEOUT,
          interruptedAtMs: null,
        });
        expect(tasker.finalizeCalls).toEqual([{ payload: { sessionId }, options: undefined }]);
        expect(tasker.notificationCalls).toEqual([]);
      });

      it.each([
        ...PRE_ADMISSION,
        "TRANSCRIBING" as const,
      ])("leaves a %s session alone one second inside the timeout", async (status) => {
        const bookingId = await seedDispatched();
        const sessionId = await seedLive(bookingId, status);
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        vi.setSystemTime(INSIDE_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(stopRequests).toEqual([]);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(tasker.notificationCalls).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("counts from the last heartbeat when it is later than the dispatch", async () => {
        const bookingId = await seedDispatched();
        const lastHeartbeatAt = offsetFromNow(60_000);
        const sessionId = await seedSessionWith(bookingId, { lastHeartbeatAt });
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        const { gateway, stopRequests } = stopRecorder();
        const service = buildService(fakeBinding(gateway));

        vi.setSystemTime(AT_TIMEOUT);
        await service.dispatchDue();

        expect(stopRequests).toEqual([]);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);

        vi.setSystemTime(new Date(lastHeartbeatAt.getTime() + HEARTBEAT_MS));
        await service.dispatchDue();

        expect(stopRequests).toEqual([{ sessionId, reason: "DISABLED" }]);
        expect(repositories.store.sessions.get(sessionId)?.status).toBe("FAILED");
      });

      it("counts from the dispatch when it is later than the last heartbeat", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSessionWith(bookingId, {
          dispatchedAt: NOW,
          lastHeartbeatAt: offsetFromNow(-60_000),
        });
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        vi.setSystemTime(INSIDE_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(stopRequests).toEqual([]);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
      });

      it.each([
        { name: "before admission", status: "SCHEDULED" as const, notices: 1, finalizes: 0 },
        { name: "after admission", status: "TRANSCRIBING" as const, notices: 0, finalizes: 1 },
      ])("changes nothing on a second run at the same clock $name", async ({
        status,
        notices,
        finalizes,
      }) => {
        const bookingId = await seedDispatched();
        const sessionId = await seedLive(bookingId, status);
        vi.setSystemTime(AT_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();
        const service = buildService(fakeBinding(gateway));
        await service.dispatchDue();
        const snapshot = await repositories.sessionRepository.findById(sessionId);

        await service.dispatchDue();

        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(tasker.notificationCalls).toHaveLength(notices);
        expect(tasker.finalizeCalls).toHaveLength(finalizes);
        expect(stopRequests).toHaveLength(1);
      });

      it.each([
        { name: "notice before admission", status: "SCHEDULED" as const },
        { name: "finalize after admission", status: "TRANSCRIBING" as const },
      ])("enqueues no $name when the transition loses the race", async ({ status }) => {
        const bookingId = await seedDispatched();
        await seedLive(bookingId, status);
        vi.setSystemTime(AT_TIMEOUT);
        vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

        await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

        expect(tasker.notificationCalls).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("still fails the session when the bot cannot be reached", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        vi.setSystemTime(AT_TIMEOUT);

        await buildService(fakeBinding(failingStop())).dispatchDue();

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "FAILED",
          outcomeReason: "INTERRUPTED",
        });
        expect(tasker.notificationCalls).toEqual([failedNotice(bookingId, sessionId)]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId }));
      });

      it("logs and keeps the FAILED session when the notice cannot be enqueued", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        vi.setSystemTime(AT_TIMEOUT);
        tasker.notificationResult = { runId: "task-failed" };

        await expect(
          buildService(fakeBinding(stopRecorder().gateway)).dispatchDue()
        ).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ bookingId, sessionId })
        );
        expect(repositories.store.sessions.get(sessionId)?.status).toBe("FAILED");
      });

      it("handles every row when finalize cannot be enqueued, and re-enqueues it one timeout later", async () => {
        const first = await seedDispatched({ id: 1, uid: "uid-1" });
        const second = await seedDispatched({ id: 2, uid: "uid-2" });
        const sessionIds = [await seedTranscribing(first), await seedTranscribing(second)];
        vi.setSystemTime(AT_TIMEOUT);
        tasker.finalizeResult = { runId: "task-failed" };
        const service = buildService(fakeBinding(stopRecorder().gateway));

        await expect(service.dispatchDue()).resolves.toBeUndefined();

        for (const sessionId of sessionIds) {
          expect(repositories.store.sessions.get(sessionId)?.status).toBe("PROCESSING");
          expect(logger.error).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ sessionId })
          );
        }

        tasker.finalizeResult = { runId: "finalize-run" };
        vi.setSystemTime(new Date(AT_TIMEOUT.getTime() + HEARTBEAT_MS));
        await service.dispatchDue();

        for (const sessionId of sessionIds) {
          expect(tasker.finalizeCalls).toContainEqual(finalizeKey(sessionId));
        }
      });

      it.each<NotetakerSessionStatusDto>([
        "READY",
        "ENDED_EARLY",
        "FAILED",
      ])("never touches a %s session", async (status) => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSessionWith(bookingId, {
          status,
          dispatchedAt: offsetFromNow(-3_600_000),
        });
        setBookingStatus("CANCELLED");
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(stopRequests).toEqual([]);
        expect(repositories.store.choices.get(bookingId)).toEqual(before);
        expect(repositories.store.activities).toEqual([]);
        expect(tasker.notificationCalls).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
      });
    });

    describe("when a PROCESSING session is stale", () => {
      const ENDED: NotetakerSessionUpdateInput = { status: "PROCESSING", admittedAt: NOW, endedAt: NOW };

      it("re-enqueues finalize with a key at exactly the timeout", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSessionWith(bookingId, ENDED);
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        vi.setSystemTime(AT_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(tasker.finalizeCalls).toEqual([finalizeKey(sessionId)]);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(stopRequests).toEqual([]);
      });

      it("enqueues nothing one second inside the timeout", async () => {
        const bookingId = await seedDispatched();
        await seedSessionWith(bookingId, ENDED);
        vi.setSystemTime(INSIDE_TIMEOUT);

        await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("counts from the dispatch when the session has no endedAt", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSessionWith(bookingId, { status: "PROCESSING", admittedAt: NOW });
        vi.setSystemTime(AT_TIMEOUT);

        await buildService(fakeBinding(stopRecorder().gateway)).dispatchDue();

        expect(tasker.finalizeCalls).toEqual([finalizeKey(sessionId)]);
      });

      it("logs and changes nothing when finalize cannot be enqueued", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSessionWith(bookingId, ENDED);
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        vi.setSystemTime(AT_TIMEOUT);
        tasker.finalizeResult = { runId: "task-failed" };

        await expect(
          buildService(fakeBinding(stopRecorder().gateway)).dispatchDue()
        ).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId }));
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
      });

      it("only re-enqueues finalize on a CANCELLED booking", async () => {
        const bookingId = await seedDispatched();
        const sessionId = await seedSessionWith(bookingId, ENDED);
        setBookingStatus("CANCELLED");
        const snapshot = await repositories.sessionRepository.findById(sessionId);
        const before = await repositories.bookingNotetakerRepository.findByBookingId(bookingId);
        vi.setSystemTime(AT_TIMEOUT);
        const { gateway, stopRequests } = stopRecorder();

        await buildService(fakeBinding(gateway)).dispatchDue();

        expect(tasker.finalizeCalls).toEqual([finalizeKey(sessionId)]);
        expect(stopRequests).toEqual([]);
        expect(repositories.store.sessions.get(sessionId)).toEqual(snapshot);
        expect(repositories.store.choices.get(bookingId)).toEqual(before);
        expect(repositories.store.activities).toEqual([]);
      });
    });

    describe("privacy", () => {
      it("logs neither the organizer's email nor the booking title", async () => {
        const cancelled = await seedDispatched({ id: 1, uid: "uid-1", status: "CANCELLED" });
        const silent = await seedDispatched({ id: 2, uid: "uid-2" });
        const admitted = await seedDispatched({ id: 3, uid: "uid-3" });
        await seedSession(cancelled, "SCHEDULED");
        await seedSession(silent, "SCHEDULED");
        await seedTranscribing(admitted);
        vi.setSystemTime(AT_TIMEOUT);
        tasker.finalizeResult = { runId: "task-failed" };

        await buildService(fakeBinding(failingStop())).dispatchDue();

        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
        expect(loggedText()).not.toContain(ORGANIZER_EMAIL);
        expect(loggedText()).not.toContain("Planning call");
      });
    });
  });

  describe("dispatchDue: sweep steps", () => {
    type SweepStep = "dispatch" | "give-up" | "void-unconfirmed" | "watchdog";
    type EnabledQuery = Parameters<
      typeof repositories.bookingNotetakerRepository.findEnabledIncludeBooking
    >[0];

    function getEnabledQueryStep(params: EnabledQuery): SweepStep {
      if (params.bookingStatuses.includes("PENDING")) return "void-unconfirmed";
      return params.endTimeGt === undefined ? "give-up" : "dispatch";
    }

    function failStepQuery(step: SweepStep): void {
      if (step === "watchdog") {
        vi.spyOn(repositories.sessionRepository, "findByStatusInIncludeBooking").mockRejectedValueOnce(
          new Error("db down")
        );
        return;
      }
      const findEnabledIncludeBooking =
        repositories.bookingNotetakerRepository.findEnabledIncludeBooking.bind(
          repositories.bookingNotetakerRepository
        );
      vi.spyOn(repositories.bookingNotetakerRepository, "findEnabledIncludeBooking").mockImplementation(
        async (params) => {
          if (getEnabledQueryStep(params) === step) throw new Error("db down");
          return findEnabledIncludeBooking(params);
        }
      );
    }

    // One booking per step at clock END: due for dispatch, past its give-up deadline, started but
    // unconfirmed, and dispatched with a session that has been silent for longer than the timeout.
    async function seedOneUnitPerStep(): Promise<{
      dueId: number;
      overdueId: number;
      unconfirmedId: number;
      silentSessionId: string;
    }> {
      vi.setSystemTime(END);
      const dueId = await seedArmed({
        id: 1,
        uid: "uid-1",
        startTime: END,
        endTime: new Date(END.getTime() + 1_800_000),
      });
      const overdueId = await seedArmed({ id: 2, uid: "uid-2" });
      const unconfirmedId = await seedArmed({ id: 3, uid: "uid-3", status: "PENDING" });
      const silentBookingId = await seedDispatched({ id: 4, uid: "uid-4" });
      const silentSessionId = await seedSessionWith(silentBookingId, { dispatchedAt: NOW });
      return { dueId, overdueId, unconfirmedId, silentSessionId };
    }

    function storeSnapshot() {
      return structuredClone({
        choices: Array.from(repositories.store.choices.values()),
        sessions: Array.from(repositories.store.sessions.values()),
        activities: repositories.store.activities,
      });
    }

    it("bounds every step's query by the sweep batch size", async () => {
      const findEnabled = vi.spyOn(repositories.bookingNotetakerRepository, "findEnabledIncludeBooking");
      const findSessions = vi.spyOn(repositories.sessionRepository, "findByStatusInIncludeBooking");

      await buildService(fakeBinding(createStubGateway())).dispatchDue();

      const enabledQueries = findEnabled.mock.calls.map((call) => call[0]);
      expect(enabledQueries).toEqual([
        {
          bookingStatuses: ["ACCEPTED"],
          startTimeLte: offsetFromNow(config.limits.joinLeadSeconds * 1000),
          endTimeGt: NOW,
          pendingDispatch: true,
          limit: NOTETAKER_SWEEP_BATCH_SIZE,
        },
        {
          bookingStatuses: ["ACCEPTED"],
          startTimeLte: NOW,
          pendingDispatch: true,
          limit: NOTETAKER_SWEEP_BATCH_SIZE,
        },
        {
          bookingStatuses: ["PENDING", "AWAITING_HOST"],
          startTimeLte: NOW,
          limit: NOTETAKER_SWEEP_BATCH_SIZE,
        },
      ]);
      // toEqual treats an undefined key as absent, and the repository reads an absent key as "no filter".
      expect(enabledQueries[1]).not.toHaveProperty("endTimeGt");
      expect(enabledQueries[2]).not.toHaveProperty("endTimeGt");
      expect(enabledQueries[2]).not.toHaveProperty("pendingDispatch");
      expect(findSessions).toHaveBeenCalledTimes(1);
      expect(findSessions).toHaveBeenCalledWith({
        statuses: ["SCHEDULED", "WAITING_TO_BE_ADMITTED", "TRANSCRIBING", "PROCESSING"],
        limit: NOTETAKER_SWEEP_BATCH_SIZE,
      });
    });

    it.each<SweepStep>([
      "dispatch",
      "give-up",
      "void-unconfirmed",
      "watchdog",
    ])("logs a failing %s query and still runs the other steps", async (step) => {
      const { dueId, overdueId, unconfirmedId, silentSessionId } = await seedOneUnitPerStep();
      failStepQuery(step);

      await expect(buildService(fakeBinding(stopRecorder().gateway)).dispatchDue()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        "Notetaker sweep step failed",
        expect.objectContaining({ step, message: "db down" })
      );
      const sessions = Array.from(repositories.store.sessions.values());
      expect({
        dispatch: sessions.some((session) => session.bookingId === dueId && session.status === "SCHEDULED"),
        "give-up": sessions.some((session) => session.bookingId === overdueId && session.status === "FAILED"),
        "void-unconfirmed": repositories.store.choices.get(unconfirmedId)?.enabled === false,
        watchdog: repositories.store.sessions.get(silentSessionId)?.status === "FAILED",
      }).toEqual({
        dispatch: true,
        "give-up": true,
        "void-unconfirmed": true,
        watchdog: true,
        [step]: false,
      });
    });

    it("skips every step when the provider is unusable", async () => {
      await seedOneUnitPerStep();
      const findEnabled = vi.spyOn(repositories.bookingNotetakerRepository, "findEnabledIncludeBooking");
      const findSessions = vi.spyOn(repositories.sessionRepository, "findByStatusInIncludeBooking");
      const before = storeSnapshot();

      await buildService(null).dispatchDue();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(findEnabled).not.toHaveBeenCalled();
      expect(findSessions).not.toHaveBeenCalled();
      expect(storeSnapshot()).toEqual(before);
      expect(tasker.notificationCalls).toEqual([]);
      expect(tasker.finalizeCalls).toEqual([]);
    });
  });

  describe("dispatchForBooking", () => {
    it("dispatches a booking inside the window", async () => {
      const bookingId = await seedArmed();
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchForBooking({ bookingUid: BOOKING_UID });
      await settle(gateway);

      const session = onlySession();
      expect(session).toMatchObject({
        bookingId,
        status: "SCHEDULED",
        meetingUrl: MEET_LINK,
        externalRef: `fake-ref-${session.id}`,
      });
      expect(gateway.joinRequests).toHaveLength(1);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    describe("writes nothing when", () => {
      const cases: {
        name: string;
        uid?: string;
        booking?: Partial<InMemoryBookingSeed>;
        noChoice?: boolean;
        choice?: { enabled?: boolean; pendingDispatch?: boolean };
      }[] = [
        { name: "the booking starts outside the window", booking: { startTime: offsetFromNow(121_000) } },
        { name: "the uid is unknown", uid: "unknown-uid" },
        { name: "there is no choice", noChoice: true },
        { name: "the choice is not armed", choice: { pendingDispatch: false } },
        { name: "the choice is disabled", choice: { enabled: false } },
        { name: "the booking is not ACCEPTED", booking: { status: "PENDING" } },
      ];

      it.each(cases)("$name", async ({ uid, booking, noChoice, choice }) => {
        const seed = buildBooking(booking);
        repositories.store.addBooking(seed);
        if (!noChoice) await arm(seed.id, choice);
        const before = repositories.store.choices.get(seed.id);
        const choiceBefore = before ? { ...before } : undefined;
        const gateway = fake();

        await buildService(fakeBinding(gateway)).dispatchForBooking({ bookingUid: uid ?? BOOKING_UID });
        await settle(gateway);

        expect(repositories.store.sessions.size).toBe(0);
        expect(gateway.joinRequests).toHaveLength(0);
        expect(repositories.store.activities).toHaveLength(0);
        expect(repositories.store.choices.get(seed.id)).toEqual(choiceBefore);
      });
    });

    it("creates one session and one join request for two concurrent calls", async () => {
      await seedArmed();
      const gateway = fake();
      const service = buildService(fakeBinding(gateway));

      await Promise.all([
        service.dispatchForBooking({ bookingUid: BOOKING_UID }),
        service.dispatchForBooking({ bookingUid: BOOKING_UID }),
      ]);
      await settle(gateway);

      expect(repositories.store.sessions.size).toBe(1);
      expect(gateway.joinRequests).toHaveLength(1);
    });

    it("enqueues one delayed attendee notice after an accepted join", async () => {
      const bookingId = await seedArmed();
      const gateway = fake();

      await buildService(fakeBinding(gateway)).dispatchForBooking({ bookingUid: BOOKING_UID });
      await settle(gateway);

      expect(tasker.notificationCalls).toEqual([
        {
          payload: { kind: "ATTENDEE_NOTICE", bookingId, sessionId: onlySession().id },
          options: { delay: "30s" },
        },
      ]);
      expect(tasker.finalizeCalls).toEqual([]);
    });

    it("enqueues one attendee notice for two concurrent calls", async () => {
      await seedArmed();
      const gateway = fake();
      const service = buildService(fakeBinding(gateway));

      await Promise.all([
        service.dispatchForBooking({ bookingUid: BOOKING_UID }),
        service.dispatchForBooking({ bookingUid: BOOKING_UID }),
      ]);
      await settle(gateway);

      expect(tasker.notificationCalls).toHaveLength(1);
    });

    it("logs an error and keeps the dispatched session when the notice cannot be enqueued", async () => {
      const bookingId = await seedArmed();
      tasker.notificationResult = { runId: "task-failed" };
      const gateway = fake();

      await expect(
        buildService(fakeBinding(gateway)).dispatchForBooking({ bookingUid: BOOKING_UID })
      ).resolves.toBeUndefined();
      await settle(gateway);

      const session = onlySession();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ bookingId, sessionId: session.id })
      );
      expect(session).toMatchObject({ status: "SCHEDULED", externalRef: `fake-ref-${session.id}` });
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(false);
    });

    it("logs an error and writes nothing when the provider is unusable", async () => {
      const bookingId = await seedArmed();

      await buildService(null).dispatchForBooking({ bookingUid: BOOKING_UID });

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(repositories.store.sessions.size).toBe(0);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
    });
  });

  describe("stopForBooking", () => {
    it.each([
      "SCHEDULED",
      "WAITING_TO_BE_ADMITTED",
    ] as const)("asks the bot to stop and deletes a %s session", async (status) => {
      const bookingId = await seedArmed();
      const sessionId = await seedSession(bookingId, status);
      const gateway = fake();

      await buildService(fakeBinding(gateway)).stopForBooking({
        bookingUid: BOOKING_UID,
        reason: "DISABLED",
      });
      await settle(gateway);

      expect(gateway.stopRequests).toEqual([{ sessionId, reason: "DISABLED" }]);
      expect(repositories.store.sessions.has(sessionId)).toBe(false);
    });

    it("deletes the row and does not throw when requestStop rejects", async () => {
      const bookingId = await seedArmed();
      const sessionId = await seedSession(bookingId, "SCHEDULED");
      const gateway = createStubGateway({
        requestStop: async () => {
          throw new Error("bot down");
        },
      });

      await expect(
        buildService(fakeBinding(gateway)).stopForBooking({ bookingUid: BOOKING_UID, reason: "DISABLED" })
      ).resolves.toBeUndefined();

      expect(repositories.store.sessions.has(sessionId)).toBe(false);
    });

    it("leaves a TRANSCRIBING session untouched", async () => {
      const bookingId = await seedArmed();
      const sessionId = await seedSession(bookingId, "TRANSCRIBING");
      const gateway = fake();

      await buildService(fakeBinding(gateway)).stopForBooking({
        bookingUid: BOOKING_UID,
        reason: "DISABLED",
      });
      await settle(gateway);

      expect(gateway.stopRequests).toHaveLength(0);
      expect(repositories.store.sessions.get(sessionId)?.status).toBe("TRANSCRIBING");
    });

    it("does nothing when the booking has no session or the uid is unknown", async () => {
      await seedArmed();
      const gateway = fake();
      const service = buildService(fakeBinding(gateway));

      await service.stopForBooking({ bookingUid: BOOKING_UID, reason: "DISABLED" });
      await service.stopForBooking({ bookingUid: "unknown-uid", reason: "DISABLED" });
      await settle(gateway);

      expect(gateway.stopRequests).toHaveLength(0);
      expect(repositories.store.sessions.size).toBe(0);
    });

    it("still deletes a pre-admission row when the provider is unusable", async () => {
      const bookingId = await seedArmed();
      const sessionId = await seedSession(bookingId, "SCHEDULED");

      await buildService(null).stopForBooking({ bookingUid: BOOKING_UID, reason: "DISABLED" });

      expect(repositories.store.sessions.has(sessionId)).toBe(false);
    });

    it("records no activity, keeps the choice enabled and enqueues nothing for a DISABLED stop", async () => {
      const bookingId = await seedArmed();
      await seedSession(bookingId, "SCHEDULED");
      const gateway = fake();

      await buildService(fakeBinding(gateway)).stopForBooking({
        bookingUid: BOOKING_UID,
        reason: "DISABLED",
      });
      await settle(gateway);

      expect(repositories.store.activities).toEqual([]);
      expect(repositories.store.choices.get(bookingId)?.enabled).toBe(true);
      expect(tasker.notificationCalls).toEqual([]);
      expect(tasker.finalizeCalls).toEqual([]);
    });
  });

  describe("stopForBooking with STOPPED_BY_HOST", () => {
    let stopRequests: { sessionId: string; reason: NotetakerBotStopReason }[];

    beforeEach(() => {
      stopRequests = [];
    });

    // Default getState resolves null, which is how the bot answers for a session it does not know.
    function recordingGateway(overrides: Partial<INotetakerBotGateway> = {}): INotetakerBotGateway {
      return createStubGateway({
        requestStop: async (input) => {
          stopRequests.push({ sessionId: input.sessionId, reason: input.reason });
        },
        ...overrides,
      });
    }

    function knownGateway(overrides: Partial<INotetakerBotGateway> = {}): INotetakerBotGateway {
      return recordingGateway({
        getState: async (sessionId) => ({ sessionId, phase: "IN_MEETING", lastEventSequence: 1 }),
        ...overrides,
      });
    }

    function failingStopGateway(error: Error): INotetakerBotGateway {
      return knownGateway({
        requestStop: async (input) => {
          stopRequests.push({ sessionId: input.sessionId, reason: input.reason });
          throw error;
        },
      });
    }

    function stoppedActivity(bookingId: number, sessionId: string | null) {
      return {
        bookingId,
        sessionId,
        action: "STOPPED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: ORGANIZER_NAME,
        detail: null,
      };
    }

    describe("authorisation and preconditions", () => {
      it("rejects an unknown booking uid with NotFound and writes nothing", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedSession(bookingId, "SCHEDULED");

        const error = await captureError(
          buildService(fakeBinding(recordingGateway())).stopForBooking({
            bookingUid: "unknown-uid",
            reason: "STOPPED_BY_HOST",
            userId: ORGANIZER_ID,
          })
        );

        expect(error.code).toBe(ErrorCode.NotFound);
        expect(repositories.store.sessions.has(sessionId)).toBe(true);
        expect(repositories.store.activities).toEqual([]);
        expect(repositories.store.choices.get(bookingId)?.enabled).toBe(true);
        expect(stopRequests).toEqual([]);
      });

      it("rejects a user who is not a host with Forbidden and leaves the session untouched", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const sessionBefore = { ...repositories.store.sessions.get(sessionId) };
        const getState = vi.fn(async () => null);

        const error = await captureError(
          hostStop(buildService(fakeBinding(recordingGateway({ getState }))), STRANGER_ID)
        );

        expect(error.code).toBe(ErrorCode.Forbidden);
        expect(repositories.store.sessions.get(sessionId)).toEqual(sessionBefore);
        expect(repositories.store.activities).toEqual([]);
        expect(stopRequests).toEqual([]);
        expect(getState).not.toHaveBeenCalled();
      });

      it("accepts an event-type host who attends the booking", async () => {
        const bookingId = await seedArmed({
          eventTypeHosts: [{ userId: CO_HOST_ID, email: "attendee@example.com" }],
        });
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        users.push({
          id: CO_HOST_ID,
          name: "Co Host",
          email: "attendee@example.com",
          locale: "en",
          timeZone: "UTC",
        });

        await hostStop(buildService(fakeBinding(recordingGateway())), CO_HOST_ID);

        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject({
          action: "STOPPED",
          actorType: "USER",
          actorUserId: CO_HOST_ID,
          actorName: "Co Host",
        });
      });

      const noActiveSessionCases: { name: string; status: NotetakerSessionStatusDto | null }[] = [
        { name: "the booking has no session", status: null },
        { name: "the session is PROCESSING", status: "PROCESSING" },
        { name: "the session is READY", status: "READY" },
        { name: "the session is FAILED", status: "FAILED" },
      ];

      it.each(noActiveSessionCases)("rejects with NO_ACTIVE_SESSION when $name", async ({ status }) => {
        const bookingId = await seedArmed();
        if (status !== null) {
          const sessionId = await seedSession(bookingId, "SCHEDULED");
          await repositories.sessionRepository.update(sessionId, { status });
        }

        const error = await captureError(hostStop(buildService(fakeBinding(recordingGateway()))));

        expect(error.code).toBe(ErrorCode.BadRequest);
        expect(error.message).toBe("NO_ACTIVE_SESSION");
        expect(repositories.store.activities).toEqual([]);
        expect(stopRequests).toEqual([]);
      });
    });

    describe("before admission", () => {
      it.each([
        "SCHEDULED",
        "WAITING_TO_BE_ADMITTED",
      ] as const)("stops the bot, deletes a %s session and disables the choice", async (status) => {
        const bookingId = await seedArmed();
        const sessionId = await seedSession(bookingId, status);
        const gateway = fake();

        await hostStop(buildService(fakeBinding(gateway)));
        await settle(gateway);

        expect(gateway.stopRequests).toEqual([{ sessionId, reason: "STOPPED_BY_HOST" }]);
        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject(stoppedActivity(bookingId, null));
        expect(repositories.store.choices.get(bookingId)).toMatchObject({
          enabled: false,
          pendingDispatch: false,
          rejoinBlocked: false,
        });
        expect(tasker.notificationCalls).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("still deletes the row, records the stop and disables the choice when requestStop rejects", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedSession(bookingId, "SCHEDULED");

        await expect(
          hostStop(buildService(fakeBinding(failingStopGateway(new Error("bot down")))))
        ).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.choices.get(bookingId)?.enabled).toBe(false);
      });

      it("deletes the row, records the stop and disables the choice when the provider is unusable", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedSession(bookingId, "SCHEDULED");

        await hostStop(buildService(null));

        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject(stoppedActivity(bookingId, null));
        expect(repositories.store.choices.get(bookingId)).toMatchObject({
          enabled: false,
          pendingDispatch: false,
          rejoinBlocked: false,
        });
        expect(tasker.notificationCalls).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("writes one activity for two concurrent stops", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedSession(bookingId, "SCHEDULED");
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        const gateway = createStubGateway({
          requestStop: async () => {
            calls += 1;
            await released;
          },
        });
        const service = buildService(fakeBinding(gateway));

        const stops = [hostStop(service), hostStop(service)];
        // Both calls must be past their session read before either deletes the row, otherwise the
        // second one would end in NO_ACTIVE_SESSION and the race would not be exercised.
        for (let turn = 0; turn < 100 && calls < 2; turn += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(calls).toBe(2);
        release();
        await expect(Promise.all(stops)).resolves.toEqual([undefined, undefined]);

        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.choices.get(bookingId)?.enabled).toBe(false);
      });

      it("records a null actor name when the user cannot be found", async () => {
        const bookingId = await seedArmed();
        await seedSession(bookingId, "SCHEDULED");
        users = [];

        await hostStop(buildService(fakeBinding(recordingGateway())));

        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject({
          actorUserId: ORGANIZER_ID,
          actorName: null,
        });
      });

      it("disarms a choice that was still pending dispatch without blocking a rejoin", async () => {
        const bookingId = await seedArmed();
        await seedSession(bookingId, "SCHEDULED");
        expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);

        await hostStop(buildService(fakeBinding(recordingGateway())));

        const choice = repositories.store.choices.get(bookingId);
        expect(choice?.pendingDispatch).toBe(false);
        expect(choice?.rejoinBlocked).toBe(false);
      });
    });

    describe("after admission, when the bot knows the session", () => {
      it("marks the stop, records it and leaves the status to the bot", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const choiceBefore = { ...repositories.store.choices.get(bookingId) };

        await hostStop(buildService(fakeBinding(knownGateway())));

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "TRANSCRIBING",
          stopRequestedAt: NOW,
          stopRequestedByUserId: ORGANIZER_ID,
          outcomeReason: null,
          endedAt: null,
        });
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject(stoppedActivity(bookingId, sessionId));
        expect(stopRequests).toEqual([{ sessionId, reason: "STOPPED_BY_HOST" }]);
        expect(repositories.store.choices.get(bookingId)).toEqual(choiceBefore);
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(false);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("re-sends the stop request and writes no second activity on a repeated stop", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const service = buildService(fakeBinding(knownGateway()));

        await hostStop(service);
        vi.setSystemTime(offsetFromNow(5_000));
        await hostStop(service);

        expect(repositories.store.sessions.get(sessionId)?.stopRequestedAt).toEqual(NOW);
        expect(stopRequests).toEqual([
          { sessionId, reason: "STOPPED_BY_HOST" },
          { sessionId, reason: "STOPPED_BY_HOST" },
        ]);
        expect(repositories.store.activities).toHaveLength(1);
      });

      it("does not overwrite a stop that another host already requested", async () => {
        const bookingId = await seedArmed();
        const requestedAt = offsetFromNow(-10_000);
        const sessionId = await seedTranscribing(bookingId, {
          stopRequestedAt: requestedAt,
          stopRequestedByUserId: CO_HOST_ID,
        });

        await hostStop(buildService(fakeBinding(knownGateway())));

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          stopRequestedAt: requestedAt,
          stopRequestedByUserId: CO_HOST_ID,
        });
        expect(repositories.store.activities).toEqual([]);
        expect(stopRequests).toEqual([{ sessionId, reason: "STOPPED_BY_HOST" }]);
      });

      it("propagates a rejecting requestStop and keeps the stop marked", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const botDown = new Error("bot down");

        await expect(hostStop(buildService(fakeBinding(failingStopGateway(botDown))))).rejects.toBe(botDown);

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "TRANSCRIBING",
          stopRequestedAt: NOW,
        });
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(false);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("re-sends the stop request and writes no second activity after a failed one", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const botDown = new Error("bot down");
        const gateway = knownGateway({
          requestStop: async (input) => {
            stopRequests.push({ sessionId: input.sessionId, reason: input.reason });
            if (stopRequests.length === 1) throw botDown;
          },
        });
        const service = buildService(fakeBinding(gateway));

        await expect(hostStop(service)).rejects.toBe(botDown);
        await expect(hostStop(service)).resolves.toBeUndefined();

        expect(stopRequests).toEqual([
          { sessionId, reason: "STOPPED_BY_HOST" },
          { sessionId, reason: "STOPPED_BY_HOST" },
        ]);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.sessions.get(sessionId)?.status).toBe("TRANSCRIBING");
      });

      it("does nothing more when the session ended between the read and the mark", async () => {
        const bookingId = await seedArmed();
        await seedTranscribing(bookingId);
        vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

        await expect(hostStop(buildService(fakeBinding(knownGateway())))).resolves.toBeUndefined();

        expect(repositories.store.activities).toEqual([]);
        expect(stopRequests).toEqual([]);
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(false);
        expect(tasker.finalizeCalls).toEqual([]);
      });

      it("treats a throwing getState as a known session", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const gateway = recordingGateway({
          getState: async () => {
            throw new Error("bot unreachable");
          },
        });

        await expect(hostStop(buildService(fakeBinding(gateway)))).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "TRANSCRIBING",
          stopRequestedAt: NOW,
        });
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(false);
        expect(tasker.finalizeCalls).toEqual([]);
      });
    });

    describe("after admission, when the bot does not know the session", () => {
      it("ends the session itself, blocks a rejoin and enqueues the finalize", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId, { lastEventSequence: 7 });

        await hostStop(buildService(fakeBinding(recordingGateway())));

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "PROCESSING",
          outcomeReason: "STOPPED_BY_HOST",
          endedAt: NOW,
          stopRequestedAt: NOW,
          stopRequestedByUserId: ORGANIZER_ID,
          lastEventSequence: 7,
        });
        expect(repositories.store.choices.get(bookingId)).toMatchObject({
          rejoinBlocked: true,
          pendingDispatch: false,
        });
        expect(tasker.finalizeCalls).toEqual([{ payload: { sessionId }, options: undefined }]);
        expect(repositories.store.activities).toHaveLength(1);
        expect(repositories.store.activities[0]).toMatchObject(stoppedActivity(bookingId, sessionId));
        expect(stopRequests).toEqual([{ sessionId, reason: "STOPPED_BY_HOST" }]);
        expect(tasker.notificationCalls).toEqual([]);
      });

      it("blocks the rejoin and disarms the choice before the session leaves TRANSCRIBING", async () => {
        const bookingId = await seedArmed();
        await seedTranscribing(bookingId);
        const updateIfStatusIn = repositories.sessionRepository.updateIfStatusIn.bind(
          repositories.sessionRepository
        );
        const choiceAtStatusWrite: { rejoinBlocked?: boolean; pendingDispatch?: boolean }[] = [];
        vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockImplementation(
          async (id, fromStatuses, data) => {
            if (data.status === "PROCESSING") {
              const choice = repositories.store.choices.get(bookingId);
              choiceAtStatusWrite.push({
                rejoinBlocked: choice?.rejoinBlocked,
                pendingDispatch: choice?.pendingDispatch,
              });
            }
            return updateIfStatusIn(id, fromStatuses, data);
          }
        );

        await hostStop(buildService(fakeBinding(recordingGateway())));

        expect(choiceAtStatusWrite).toEqual([{ rejoinBlocked: true, pendingDispatch: false }]);
      });

      it("takes the same path when the provider is unusable", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);

        await hostStop(buildService(null));

        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "PROCESSING",
          outcomeReason: "STOPPED_BY_HOST",
          endedAt: NOW,
          stopRequestedAt: NOW,
          stopRequestedByUserId: ORGANIZER_ID,
        });
        expect(repositories.store.choices.get(bookingId)).toMatchObject({
          rejoinBlocked: true,
          pendingDispatch: false,
        });
        expect(repositories.store.activities).toHaveLength(1);
        expect(tasker.finalizeCalls).toEqual([{ payload: { sessionId }, options: undefined }]);
      });

      it("ends the session without a second activity when the stop was already requested", async () => {
        const bookingId = await seedArmed();
        const requestedAt = offsetFromNow(-10_000);
        const sessionId = await seedTranscribing(bookingId, {
          stopRequestedAt: requestedAt,
          stopRequestedByUserId: ORGANIZER_ID,
        });

        await hostStop(buildService(fakeBinding(recordingGateway())));

        expect(repositories.store.activities).toEqual([]);
        expect(repositories.store.sessions.get(sessionId)).toMatchObject({
          status: "PROCESSING",
          stopRequestedAt: requestedAt,
        });
        expect(tasker.finalizeCalls).toEqual([{ payload: { sessionId }, options: undefined }]);
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(true);
      });

      it("does not enqueue a finalize when the session left TRANSCRIBING before the status write", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        const gateway = recordingGateway({
          getState: async (id) => {
            await repositories.sessionRepository.update(id, { status: "PROCESSING" });
            return null;
          },
        });

        await expect(hostStop(buildService(fakeBinding(gateway)))).resolves.toBeUndefined();

        expect(tasker.finalizeCalls).toEqual([]);
        expect(repositories.store.sessions.get(sessionId)?.outcomeReason).toBeNull();
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(true);
      });

      it("throws InternalServerError naming the session when the finalize cannot be enqueued", async () => {
        const bookingId = await seedArmed();
        const sessionId = await seedTranscribing(bookingId);
        tasker.finalizeResult = { runId: "task-failed" };

        const error = await captureError(hostStop(buildService(fakeBinding(recordingGateway()))));

        expect(error.code).toBe(ErrorCode.InternalServerError);
        expect(error.message).toContain(sessionId);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId }));
        expect(repositories.store.sessions.get(sessionId)?.status).toBe("PROCESSING");
        expect(repositories.store.choices.get(bookingId)?.rejoinBlocked).toBe(true);
        expect(repositories.store.activities).toHaveLength(1);
      });

      it("answers NO_ACTIVE_SESSION to a retry after the finalize could not be enqueued", async () => {
        const bookingId = await seedArmed();
        await seedTranscribing(bookingId);
        tasker.finalizeResult = { runId: "task-failed" };
        const service = buildService(fakeBinding(recordingGateway()));
        await captureError(hostStop(service));

        const error = await captureError(hostStop(service));

        expect(error.code).toBe(ErrorCode.BadRequest);
        expect(error.message).toBe("NO_ACTIVE_SESSION");
        expect(tasker.finalizeCalls).toHaveLength(1);
        expect(repositories.store.activities).toHaveLength(1);
      });
    });

    describe("privacy", () => {
      it("logs no email address when requestStop fails before admission", async () => {
        const bookingId = await seedArmed();
        await seedSession(bookingId, "SCHEDULED");

        await hostStop(buildService(fakeBinding(failingStopGateway(new Error("bot down")))));

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(loggedText()).not.toContain(ORGANIZER_EMAIL);
      });

      it("logs no email address when the finalize cannot be enqueued", async () => {
        const bookingId = await seedArmed();
        await seedTranscribing(bookingId);
        tasker.finalizeResult = { runId: "task-failed" };

        await captureError(hostStop(buildService(fakeBinding(recordingGateway()))));

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(loggedText()).not.toContain(ORGANIZER_EMAIL);
      });
    });
  });
});

describe("NotetakerBotGateway.module resolver", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function loadResolver(): INotetakerBotGatewayResolver {
    const container = createContainer();
    botGatewayModuleLoader.loadModule(container);
    return container.get<INotetakerBotGatewayResolver>(botGatewayModuleLoader.token);
  }

  it("loads and resolves to null in production when no provider is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NOTETAKER_BOT_PROVIDER", "");

    const resolver = loadResolver();

    expect(resolver.resolve()).toBeNull();
  });

  it("resolves the fake provider once and returns the same resolver and binding", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NOTETAKER_BOT_PROVIDER", "fake");
    const container = createContainer();
    botGatewayModuleLoader.loadModule(container);

    const first = container.get<INotetakerBotGatewayResolver>(botGatewayModuleLoader.token);
    const second = container.get<INotetakerBotGatewayResolver>(botGatewayModuleLoader.token);
    const binding = first.resolve();

    expect(second).toBe(first);
    expect(binding).not.toBeNull();
    expect(binding?.provider).toBe("FAKE");
    expect(binding?.gateway).toBeInstanceOf(FakeBotGateway);
    expect(second.resolve()).toBe(binding);
  });

  it("resolves the self-hosted provider when a URL and secret are set", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NOTETAKER_BOT_PROVIDER", "self_hosted");
    vi.stubEnv("NOTETAKER_BOT_URL", "https://bot.example.com");
    vi.stubEnv("NOTETAKER_BOT_SECRET", "test-secret");

    const binding = loadResolver().resolve();

    expect(binding?.provider).toBe("SELF_HOSTED");
  });

  it("resolves to null without throwing when the environment is invalid", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NOTETAKER_BOT_PROVIDER", "fake");
    vi.stubEnv("NOTETAKER_JOIN_LEAD_SECONDS", "abc");

    const resolver = loadResolver();

    expect(() => resolver.resolve()).not.toThrow();
    expect(resolver.resolve()).toBeNull();
  });
});
