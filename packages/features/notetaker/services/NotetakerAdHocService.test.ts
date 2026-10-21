import { getTranslation } from "@calcom/i18n/server";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAdHocBookingMetadata } from "../lib/adHocMeeting";
import type { NotetakerConfig } from "../lib/config";
import type { INotetakerUserLookup } from "../lib/userLookup";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import type { NotetakerAdHocErrorCode } from "./NotetakerAdHocService";
import { NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY, NotetakerAdHocService } from "./NotetakerAdHocService";

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(async (locale: string, _namespace: string) => (key: string) => `${locale}:${key}`),
}));

const NOW = new Date("2026-10-15T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const USER_ID = 1;
const TEAM_ID = 20;
const OTHER_TEAM_ID = 21;
const PENDING_TEAM_ID = 22;

const MEET_URL = "https://meet.google.com/abc-defg-hij";
const OTHER_MEET_URL = "https://meet.google.com/xyz-wxyz-xyz";

function buildConfig(overrides: Partial<NotetakerConfig> = {}): NotetakerConfig {
  return {
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 14400,
      joinLeadSeconds: 120,
      heartbeatTimeoutSeconds: 180,
      summaryMinWords: 40,
    },
    enabledPlatforms: ["GOOGLE_MEET"],
    botProvider: "FAKE",
    botUrl: null,
    botSecret: null,
    summaryModel: "test-model",
    anthropicApiKey: null,
    fakeScenario: "happy",
    googleAccountEmail: null,
    recall: null,
    ...overrides,
  };
}

function withMaxDurationSeconds(maxDurationSeconds: number): NotetakerConfig {
  const config = buildConfig();
  return { ...config, limits: { ...config.limits, maxDurationSeconds } };
}

async function expectAdHocError(promise: Promise<unknown>, code: NotetakerAdHocErrorCode) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(ErrorCode.BadRequest);
  expect(error.message).toBe(code);
}

describe("NotetakerAdHocService", () => {
  const checkIfUserHasFeature = vi.fn(async (_userId: number, _slug: string): Promise<boolean> => true);
  const calls: string[] = [];
  const setEnabled = vi.fn(
    async (_params: { bookingUid: string; enabled: boolean; scope: string; userId: number }) => {
      calls.push("setEnabled");
    }
  );
  const dispatchForBooking = vi.fn(async (_params: { bookingUid: string }) => {
    calls.push("dispatch");
  });
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  let userLocale: string | null;
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let service: NotetakerAdHocService;

  function buildService(config: NotetakerConfig = buildConfig()): NotetakerAdHocService {
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) =>
        ids.map((id) => ({
          id,
          name: null,
          email: `user${id}@example.com`,
          locale: userLocale,
          timeZone: "UTC",
        })),
    };
    const bookingNotetakerRepository = repositories.bookingNotetakerRepository;
    return new NotetakerAdHocService({
      bookingNotetakerRepository: {
        createAdHocBooking: async (data) => {
          calls.push("create");
          return bookingNotetakerRepository.createAdHocBooking(data);
        },
        countAdHocByUserIdSince: (params) => bookingNotetakerRepository.countAdHocByUserIdSince(params),
        findActiveAdHocByUserId: (params) => bookingNotetakerRepository.findActiveAdHocByUserId(params),
      },
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
      featuresRepository: { checkIfUserHasFeature },
      choiceService: { setEnabled },
      dispatchService: { dispatchForBooking },
      userRepository,
      config,
      logger,
    });
  }

  async function seedAdHoc(params: { createdAt: Date; endTime: Date; location?: string }) {
    const booking = await repositories.bookingNotetakerRepository.createAdHocBooking({
      uid: `seeded-${repositories.store.bookings.size + 1}`,
      userId: USER_ID,
      title: "Earlier meeting",
      startTime: params.createdAt,
      endTime: params.endTime,
      location: params.location ?? OTHER_MEET_URL,
      metadata: { notetakerAdHoc: "true" },
    });
    repositories.store.bookingCreatedAt.set(booking.id, params.createdAt);
    return booking;
  }

  async function seedEndedAdHoc(count: number, createdAt: Date) {
    for (let i = 0; i < count; i += 1) {
      await seedAdHoc({ createdAt, endTime: new Date(createdAt.getTime() + MINUTE_MS) });
    }
  }

  function adHocBookings() {
    return Array.from(repositories.store.bookings.values());
  }

  function dispatch(overrides: Partial<Parameters<NotetakerAdHocService["dispatchToMeeting"]>[0]> = {}) {
    return service.dispatchToMeeting({
      userId: USER_ID,
      meetingUrl: MEET_URL,
      sharingTeamId: null,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    calls.length = 0;
    checkIfUserHasFeature.mockReset();
    checkIfUserHasFeature.mockResolvedValue(true);
    setEnabled.mockClear();
    dispatchForBooking.mockClear();
    dispatchForBooking.mockImplementation(async () => {
      calls.push("dispatch");
    });
    logger.warn.mockClear();
    vi.mocked(getTranslation).mockClear();
    userLocale = null;
    repositories = createInMemoryNotetakerRepositories();
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    repositories.store.setTeam(TEAM_ID, "Sales");
    repositories.store.setTeam(OTHER_TEAM_ID, "Support");
    repositories.store.setTeam(PENDING_TEAM_ID, "Pending");
    membershipLookup.addMember({ teamId: TEAM_ID, userId: USER_ID });
    membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: USER_ID });
    membershipLookup.addMember({ teamId: PENDING_TEAM_ID, userId: USER_ID, accepted: false });
    service = buildService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getOptions", () => {
    it("lists the user's accepted teams with the duration defaults", async () => {
      const options = await service.getOptions({ userId: USER_ID });

      expect(checkIfUserHasFeature).toHaveBeenCalledWith(USER_ID, "notetaker");
      expect(options).toEqual({
        featureEnabled: true,
        teamOptions: [
          { teamId: TEAM_ID, name: "Sales" },
          { teamId: OTHER_TEAM_ID, name: "Support" },
        ],
        defaultDurationMinutes: 60,
        maxDurationMinutes: 240,
      });
    });

    it("reports the feature as off without the flag", async () => {
      checkIfUserHasFeature.mockResolvedValue(false);

      const options = await service.getOptions({ userId: USER_ID });

      expect(options).toMatchObject({ featureEnabled: false, teamOptions: [] });
    });

    it("reports the feature as off when the bot provider is unusable", async () => {
      service = buildService(buildConfig({ botProvider: null }));

      const options = await service.getOptions({ userId: USER_ID });

      expect(options).toMatchObject({ featureEnabled: false, teamOptions: [] });
    });

    it("caps the maximum duration at the configured bot limit", async () => {
      service = buildService(withMaxDurationSeconds(90 * 60 + 59));

      const options = await service.getOptions({ userId: USER_ID });

      expect(options.maxDurationMinutes).toBe(90);
      expect(options.defaultDurationMinutes).toBe(60);
    });

    it("caps the default duration at a bot limit shorter than the default", async () => {
      service = buildService(withMaxDurationSeconds(30 * 60));

      const options = await service.getOptions({ userId: USER_ID });

      expect(options).toMatchObject({ defaultDurationMinutes: 30, maxDurationMinutes: 30 });
    });
  });

  describe("dispatchToMeeting", () => {
    it("creates an ad-hoc booking, enables the notetaker for it and dispatches the bot", async () => {
      const result = await dispatch({ title: "  Weekly sync  ", sharingTeamId: TEAM_ID });

      expect(result.reused).toBe(false);
      const [booking] = adHocBookings();
      expect(booking).toMatchObject({
        uid: result.bookingUid,
        userId: USER_ID,
        status: "ACCEPTED",
        title: "Weekly sync",
        location: MEET_URL,
        startTime: NOW,
        endTime: new Date(NOW.getTime() + 60 * MINUTE_MS),
        eventTypeId: null,
      });
      expect(readAdHocBookingMetadata(booking.metadata)).toEqual({ isAdHoc: true, sharingTeamId: TEAM_ID });
      expect(calls).toEqual(["create", "setEnabled", "dispatch"]);
      expect(setEnabled).toHaveBeenCalledWith({
        bookingUid: result.bookingUid,
        enabled: true,
        scope: "THIS_BOOKING",
        userId: USER_ID,
      });
      expect(dispatchForBooking).toHaveBeenCalledWith({ bookingUid: result.bookingUid });
    });

    it("stores the normalised meeting link", async () => {
      await dispatch({ meetingUrl: "  https://meet.google.com/ABC-DEFG-HIJ/  " });

      expect(adHocBookings()[0].location).toBe(MEET_URL);
    });

    it("leaves sharing to the hosts when no team is chosen", async () => {
      await dispatch();

      expect(readAdHocBookingMetadata(adHocBookings()[0].metadata)).toEqual({
        isAdHoc: true,
        sharingTeamId: null,
      });
    });

    it("gives each booking a fresh uid", async () => {
      const first = await dispatch();
      vi.setSystemTime(new Date(NOW.getTime() + 61 * MINUTE_MS));
      const second = await dispatch();

      expect(first.bookingUid).not.toBe(second.bookingUid);
    });

    describe("title", () => {
      it("uses the translated default title in the user's locale when none is given", async () => {
        userLocale = "de";

        await dispatch();

        expect(getTranslation).toHaveBeenCalledWith("de", "common");
        expect(adHocBookings()[0].title).toBe("de:notetaker_ad_hoc_default_title");
      });

      it("uses the default title for a blank title and falls back to English", async () => {
        await dispatch({ title: "   " });

        expect(adHocBookings()[0].title).toBe("en:notetaker_ad_hoc_default_title");
      });
    });

    describe("duration", () => {
      it("accepts the minimum and the maximum", async () => {
        await dispatch({ durationMinutes: 15 });
        expect(adHocBookings()[0].endTime).toEqual(new Date(NOW.getTime() + 15 * MINUTE_MS));

        vi.setSystemTime(new Date(NOW.getTime() + 16 * MINUTE_MS));
        await dispatch({ durationMinutes: 240 });
        expect(adHocBookings()[1].endTime).toEqual(new Date(NOW.getTime() + (16 + 240) * MINUTE_MS));
      });

      it.each([14, 241, 0, -5, 30.5, Number.NaN])("rejects %s minutes", async (durationMinutes) => {
        await expectAdHocError(dispatch({ durationMinutes }), "INVALID_DURATION");
        expect(adHocBookings()).toHaveLength(0);
      });

      it("rejects a duration above the configured bot limit", async () => {
        service = buildService(withMaxDurationSeconds(45 * 60));

        await expectAdHocError(dispatch({ durationMinutes: 46 }), "INVALID_DURATION");
        await expect(dispatch({ durationMinutes: 45 })).resolves.toMatchObject({ reused: false });
      });

      it("defaults to the bot limit when it is shorter than the default", async () => {
        service = buildService(withMaxDurationSeconds(30 * 60));

        await expect(dispatch()).resolves.toMatchObject({ reused: false });
        expect(adHocBookings()[0].endTime).toEqual(new Date(NOW.getTime() + 30 * MINUTE_MS));
      });

      it("still rejects an explicit duration above a bot limit shorter than the default", async () => {
        service = buildService(withMaxDurationSeconds(30 * 60));

        await expectAdHocError(dispatch({ durationMinutes: 31 }), "INVALID_DURATION");
        await expectAdHocError(dispatch({ durationMinutes: 60 }), "INVALID_DURATION");
        expect(adHocBookings()).toHaveLength(0);
      });
    });

    describe("reuse", () => {
      it("returns the live meeting for the same link without creating another", async () => {
        const live = await seedAdHoc({
          createdAt: new Date(NOW.getTime() - 10 * MINUTE_MS),
          endTime: new Date(NOW.getTime() + 50 * MINUTE_MS),
          location: MEET_URL,
        });

        const result = await dispatch({ meetingUrl: "https://meet.google.com/ABC-DEFG-HIJ" });

        expect(result).toEqual({ bookingUid: live.uid, reused: true });
        expect(adHocBookings()).toHaveLength(1);
        expect(setEnabled).not.toHaveBeenCalled();
        expect(dispatchForBooking).not.toHaveBeenCalled();
      });

      it("reuses the live meeting even when the daily limit is reached", async () => {
        await seedEndedAdHoc(NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY, new Date(NOW.getTime() - DAY_MS / 2));
        const live = await seedAdHoc({
          createdAt: new Date(NOW.getTime() - MINUTE_MS),
          endTime: new Date(NOW.getTime() + MINUTE_MS),
          location: MEET_URL,
        });

        await expect(dispatch()).resolves.toEqual({ bookingUid: live.uid, reused: true });
      });

      it("does not reuse a meeting that has ended", async () => {
        await seedAdHoc({
          createdAt: new Date(NOW.getTime() - 60 * MINUTE_MS),
          endTime: NOW,
          location: MEET_URL,
        });

        const result = await dispatch();

        expect(result.reused).toBe(false);
        expect(adHocBookings()).toHaveLength(2);
      });
    });

    describe("limits", () => {
      it("allows one live meeting at a time", async () => {
        await seedAdHoc({
          createdAt: new Date(NOW.getTime() - MINUTE_MS),
          endTime: new Date(NOW.getTime() + MINUTE_MS),
          location: OTHER_MEET_URL,
        });

        await expectAdHocError(dispatch(), "AD_HOC_LIMIT_REACHED");
        expect(adHocBookings()).toHaveLength(1);
      });

      it("rejects the meeting past the daily limit, counting one created exactly 24 hours ago", async () => {
        await seedEndedAdHoc(
          NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY - 1,
          new Date(NOW.getTime() - MINUTE_MS * 120)
        );
        await seedEndedAdHoc(1, new Date(NOW.getTime() - DAY_MS));

        await expectAdHocError(dispatch(), "AD_HOC_LIMIT_REACHED");
        expect(adHocBookings()).toHaveLength(NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY);
      });

      it("ignores meetings created more than 24 hours ago", async () => {
        await seedEndedAdHoc(
          NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY - 1,
          new Date(NOW.getTime() - MINUTE_MS * 120)
        );
        await seedEndedAdHoc(1, new Date(NOW.getTime() - DAY_MS - 1));

        await expect(dispatch()).resolves.toMatchObject({ reused: false });
      });
    });

    describe("team", () => {
      it("rejects a team the user is not an accepted member of", async () => {
        await expectAdHocError(dispatch({ sharingTeamId: PENDING_TEAM_ID }), "TEAM_NOT_ALLOWED");
        await expectAdHocError(dispatch({ sharingTeamId: 999 }), "TEAM_NOT_ALLOWED");
        expect(adHocBookings()).toHaveLength(0);
      });

      it("accepts any of the user's accepted teams", async () => {
        await dispatch({ sharingTeamId: OTHER_TEAM_ID });

        expect(readAdHocBookingMetadata(adHocBookings()[0].metadata).sharingTeamId).toBe(OTHER_TEAM_ID);
      });
    });

    describe("validation order", () => {
      it("reports FEATURE_DISABLED first", async () => {
        checkIfUserHasFeature.mockResolvedValue(false);
        service = buildService(buildConfig({ botProvider: null }));

        await expectAdHocError(dispatch({ meetingUrl: "not a link" }), "FEATURE_DISABLED");
        expect(checkIfUserHasFeature).toHaveBeenCalledWith(USER_ID, "notetaker");
      });

      it("reports PROVIDER_UNAVAILABLE before checking the link", async () => {
        service = buildService(buildConfig({ botProvider: null }));

        await expectAdHocError(dispatch({ meetingUrl: "not a link" }), "PROVIDER_UNAVAILABLE");
      });

      it("reports an invalid link", async () => {
        await expectAdHocError(
          dispatch({ meetingUrl: "https://meet.google.com/not-a-code" }),
          "INVALID_MEETING_LINK"
        );
      });

      it("reports a link to another meeting platform", async () => {
        await expectAdHocError(
          dispatch({ meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc" }),
          "UNSUPPORTED_PLATFORM"
        );
      });

      it("checks the limits before the team", async () => {
        await seedAdHoc({
          createdAt: new Date(NOW.getTime() - MINUTE_MS),
          endTime: new Date(NOW.getTime() + MINUTE_MS),
        });

        await expectAdHocError(dispatch({ sharingTeamId: 999 }), "AD_HOC_LIMIT_REACHED");
      });

      it("checks the team before the duration", async () => {
        await expectAdHocError(dispatch({ sharingTeamId: 999, durationMinutes: 1 }), "TEAM_NOT_ALLOWED");
      });

      it("creates nothing and calls nothing on any validation failure", async () => {
        checkIfUserHasFeature.mockResolvedValueOnce(false);
        await expectAdHocError(dispatch(), "FEATURE_DISABLED");
        await expectAdHocError(dispatch({ meetingUrl: "" }), "INVALID_MEETING_LINK");
        await expectAdHocError(dispatch({ durationMinutes: 500 }), "INVALID_DURATION");

        expect(calls).toEqual([]);
        expect(adHocBookings()).toHaveLength(0);
      });
    });

    describe("failures after the booking is created", () => {
      it("lets a dispatch failure surface and keeps the enabled booking", async () => {
        dispatchForBooking.mockRejectedValueOnce(new Error("bot unreachable"));

        await expect(dispatch()).rejects.toThrow("bot unreachable");
        expect(adHocBookings()).toHaveLength(1);
        expect(setEnabled).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      it("does not dispatch when enabling fails", async () => {
        setEnabled.mockRejectedValueOnce(new Error("enable failed"));

        await expect(dispatch()).rejects.toThrow("enable failed");
        expect(dispatchForBooking).not.toHaveBeenCalled();
      });
    });
  });
});
