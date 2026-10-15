import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBotGateway } from "../bot/FakeBotGateway";
import type { NotetakerConfig } from "../lib/config";
import { getNotetakerConfig } from "../lib/config";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerAccessService } from "./NotetakerAccessService";
import { NotetakerAdHocService } from "./NotetakerAdHocService";
import { NotetakerChoiceService } from "./NotetakerChoiceService";
import { NotetakerDispatchService } from "./NotetakerDispatchService";

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(
    async (locale: string) => (key: string, vars?: Record<string, string>) =>
      `${locale}:${key}:${JSON.stringify(vars ?? {})}`
  ),
}));

// The unit tests stub the choice and dispatch services; this one runs the real ones on the
// in-memory repositories, so a fresh ad-hoc booking must pass the host and eligibility checks and
// reach the bot gateway as it would in production.

const NOW = new Date("2026-10-15T10:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const OWNER_ID = 1;
const OWNER_NAME = "Owner";
const TEAM_ID = 20;
const MEET_URL = "https://meet.google.com/abc-defg-hij";

const PLAIN_NOTICE = `en:notetaker_meeting_notice:${JSON.stringify({ hostName: OWNER_NAME })}`;
const SHARED_NOTICE = `en:notetaker_meeting_notice_shared:${JSON.stringify({ hostName: OWNER_NAME })}`;

class RecordingTasker implements INotetakerTasker {
  async finalizeSession(
    _payload: NotetakerFinalizeSessionPayload,
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    return { runId: "finalize-run" };
  }

  async generateSummary(
    _payload: NotetakerGenerateSummaryPayload,
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    return { runId: "summary-run" };
  }

  async sendNotification(
    _payload: NotetakerSendNotificationPayload,
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    return { runId: "notification-run" };
  }
}

describe("NotetakerAdHocService wiring with the real choice and dispatch services", () => {
  const config: NotetakerConfig = getNotetakerConfig({});
  const logger: ISimpleLogger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let gateway: FakeBotGateway;
  let service: NotetakerAdHocService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    repositories = createInMemoryNotetakerRepositories();
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    repositories.store.setUser(OWNER_ID, { name: OWNER_NAME, email: "owner@example.com", avatarUrl: null });
    repositories.store.setTeam(TEAM_ID, "Sales");
    gateway = new FakeBotGateway({
      scenario: "manual",
      eventSink: async (_event: NotetakerBotEvent) => {},
    });

    const users: NotetakerUserRecord[] = [
      { id: OWNER_ID, name: OWNER_NAME, email: "owner@example.com", locale: "en", timeZone: "UTC" },
    ];
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) => users.filter((user) => ids.includes(user.id)),
    };
    const featuresRepository = { checkIfUserHasFeature: async () => true };
    const tasker = new RecordingTasker();
    const accessService = new NotetakerAccessService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      sessionRepository: repositories.sessionRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
    });
    const choiceService = new NotetakerChoiceService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      summaryRepository: repositories.summaryRepository,
      activityRepository: repositories.activityRepository,
      accessService,
      membershipLookup,
      featuresRepository,
      userRepository,
      notetakerTasker: tasker,
      logger,
      config,
    });
    const dispatchService = new NotetakerDispatchService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      sessionRepository: repositories.sessionRepository,
      activityRepository: repositories.activityRepository,
      botGatewayResolver: { resolve: () => ({ gateway, provider: "FAKE" }) },
      config,
      logger,
      accessService,
      userRepository,
      notetakerTasker: tasker,
      calendarInviteService: { ensureBotInvited: async () => "NOT_CONFIGURED" },
    });
    service = new NotetakerAdHocService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
      featuresRepository,
      choiceService,
      dispatchService,
      userRepository,
      config,
      logger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function dispatchAndSettle(sharingTeamId: number | null) {
    const result = await service.dispatchToMeeting({
      userId: OWNER_ID,
      meetingUrl: "  https://meet.google.com/ABC-DEFG-HIJ/  ",
      sharingTeamId,
    });
    await gateway.whenIdle();
    expect(gateway.scriptErrors).toEqual([]);
    return result;
  }

  function onlyBooking() {
    const bookings = Array.from(repositories.store.bookings.values());
    expect(bookings).toHaveLength(1);
    return bookings[0];
  }

  function onlySession() {
    const sessions = Array.from(repositories.store.sessions.values());
    expect(sessions).toHaveLength(1);
    return sessions[0];
  }

  it("enables a fresh ad-hoc booking with no team and sends one join with the plain notice", async () => {
    const result = await dispatchAndSettle(null);

    expect(result.reused).toBe(false);
    const booking = onlyBooking();
    expect(booking).toMatchObject({
      uid: result.bookingUid,
      userId: OWNER_ID,
      eventTypeId: null,
      location: MEET_URL,
      startTime: NOW,
      endTime: new Date(NOW.getTime() + 60 * MINUTE_MS),
    });
    expect(repositories.store.choices.get(booking.id)).toMatchObject({
      enabled: true,
      pendingDispatch: false,
    });
    expect(gateway.joinRequests).toHaveLength(1);
    expect(gateway.joinRequests[0]).toMatchObject({
      platform: "GOOGLE_MEET",
      meetingUrl: MEET_URL,
      scheduledStartAt: NOW.toISOString(),
      noticeMessage: PLAIN_NOTICE,
    });
    expect(onlySession()).toMatchObject({
      bookingId: booking.id,
      platform: "GOOGLE_MEET",
      meetingUrl: MEET_URL,
      scheduledStartAt: NOW,
      colleagueSharingDisclosed: false,
    });
  });

  it("sends the shared notice and discloses the session when the owner chose a team they belong to", async () => {
    membershipLookup.addMember({ teamId: TEAM_ID, userId: OWNER_ID });

    const result = await dispatchAndSettle(TEAM_ID);

    expect(result.reused).toBe(false);
    const booking = onlyBooking();
    expect(repositories.store.choices.get(booking.id)).toMatchObject({
      enabled: true,
      pendingDispatch: false,
    });
    expect(gateway.joinRequests).toHaveLength(1);
    expect(gateway.joinRequests[0]).toMatchObject({
      platform: "GOOGLE_MEET",
      meetingUrl: MEET_URL,
      scheduledStartAt: NOW.toISOString(),
      noticeMessage: SHARED_NOTICE,
    });
    expect(onlySession()).toMatchObject({
      platform: "GOOGLE_MEET",
      colleagueSharingDisclosed: true,
    });
  });

  it("reuses the live meeting for the same link and sends no second join", async () => {
    const first = await dispatchAndSettle(null);
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MINUTE_MS));

    const second = await dispatchAndSettle(null);

    expect(second).toEqual({ bookingUid: first.bookingUid, reused: true });
    onlyBooking();
    onlySession();
    expect(gateway.joinRequests).toHaveLength(1);
  });
});
