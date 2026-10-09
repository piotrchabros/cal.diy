import { MeetLocationType } from "@calcom/app-store/constants";
import { createContainer } from "@calcom/features/di/di";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerBotEvent, NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
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
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerDispatchService } from "./NotetakerDispatchService";

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

describe("NotetakerDispatchService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let events: NotetakerBotEvent[];
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  const config: NotetakerConfig = getNotetakerConfig({});

  const eventSink = async (event: NotetakerBotEvent): Promise<void> => {
    events.push(event);
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    repositories = createInMemoryNotetakerRepositories();
    events = [];
    logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function buildService(binding: NotetakerBotGatewayBinding | null): NotetakerDispatchService {
    return new NotetakerDispatchService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      sessionRepository: repositories.sessionRepository,
      activityRepository: repositories.activityRepository,
      botGatewayResolver: { resolve: () => binding },
      config,
      logger,
    });
  }

  function fake(scenario: NotetakerFakeScenario = "manual"): FakeBotGateway {
    return new FakeBotGateway({ scenario, eventSink });
  }

  function fakeBinding(gateway: INotetakerBotGateway): NotetakerBotGatewayBinding {
    return { gateway, provider: "FAKE" };
  }

  async function settle(gateway: FakeBotGateway): Promise<void> {
    await gateway.whenIdle();
    expect(gateway.scriptErrors).toEqual([]);
  }

  async function arm(
    bookingId: number,
    overrides: { enabled?: boolean; pendingDispatch?: boolean } = {}
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

  function onlySession() {
    const sessions = Array.from(repositories.store.sessions.values());
    expect(sessions).toHaveLength(1);
    return sessions[0];
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
    });

    it("logs one error and writes nothing when the provider is unusable", async () => {
      const bookingId = await seedArmed();

      await buildService(null).dispatchDue();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(repositories.store.sessions.size).toBe(0);
      expect(repositories.store.choices.get(bookingId)?.pendingDispatch).toBe(true);
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
