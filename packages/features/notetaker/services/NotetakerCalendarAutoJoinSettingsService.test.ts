import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  INotetakerCalendarAutoJoinRepository,
  NotetakerUserLevelSelectedCalendarWithAutoJoinRecord,
} from "../repositories/interfaces/INotetakerCalendarAutoJoinRepository";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import { NotetakerCalendarAutoJoinSettingsService } from "./NotetakerCalendarAutoJoinSettingsService";

const USER_ID = 1;
const OTHER_USER_ID = 2;
const TEAM_ID = 20;
const OTHER_TEAM_ID = 21;
const PENDING_TEAM_ID = 22;
const GOOGLE = "google_calendar";
const OFFICE = "office365_calendar";

type StoredCalendar = {
  id: string;
  userId: number;
  integration: string;
  externalId: string;
  eventTypeId: number | null;
};
type StoredAutoJoin = {
  selectedCalendarId: string;
  userId: number;
  enabled: boolean;
  sharingTeamId: number | null;
  lastPollError: string | null;
};

type AutoJoinRepository = Pick<
  INotetakerCalendarAutoJoinRepository,
  "findUserLevelSelectedCalendarsIncludeAutoJoin" | "findUserLevelSelectedCalendar" | "upsert"
>;

class FakeAutoJoinRepository implements AutoJoinRepository {
  calendars: StoredCalendar[] = [];
  rows = new Map<string, StoredAutoJoin>();

  async findUserLevelSelectedCalendarsIncludeAutoJoin({
    userId,
  }: {
    userId: number;
  }): Promise<NotetakerUserLevelSelectedCalendarWithAutoJoinRecord[]> {
    return this.calendars
      .filter((calendar) => calendar.userId === userId && calendar.eventTypeId === null)
      .map(({ id, integration, externalId }) => {
        const row = this.rows.get(id);
        return {
          id,
          integration,
          externalId,
          autoJoin: row
            ? { enabled: row.enabled, sharingTeamId: row.sharingTeamId, lastPollError: row.lastPollError }
            : null,
        };
      });
  }

  async findUserLevelSelectedCalendar(params: { selectedCalendarId: string; userId: number }) {
    const calendar = this.calendars.find(
      (c) => c.id === params.selectedCalendarId && c.userId === params.userId && c.eventTypeId === null
    );
    return calendar ? { id: calendar.id, integration: calendar.integration } : null;
  }

  async upsert(params: {
    selectedCalendarId: string;
    userId: number;
    enabled: boolean;
    sharingTeamId: number | null;
  }): Promise<void> {
    const existing = this.rows.get(params.selectedCalendarId);
    this.rows.set(params.selectedCalendarId, { lastPollError: existing?.lastPollError ?? null, ...params });
  }
}

const TEAM_NAMES: Record<number, string> = {
  [TEAM_ID]: "Sales",
  [OTHER_TEAM_ID]: "Support",
  [PENDING_TEAM_ID]: "Pending",
};

async function expectErrorCode(promise: Promise<unknown>, code: ErrorCode) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(code);
}

describe("NotetakerCalendarAutoJoinSettingsService", () => {
  let repository: FakeAutoJoinRepository;
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let flags: Set<string>;
  let supportedIntegrations: string[];
  let service: NotetakerCalendarAutoJoinSettingsService;

  beforeEach(() => {
    repository = new FakeAutoJoinRepository();
    repository.calendars = [
      {
        id: "sc-google",
        userId: USER_ID,
        integration: GOOGLE,
        externalId: "me@example.com",
        eventTypeId: null,
      },
      {
        id: "sc-office",
        userId: USER_ID,
        integration: OFFICE,
        externalId: "me@outlook.com",
        eventTypeId: null,
      },
      { id: "sc-event", userId: USER_ID, integration: GOOGLE, externalId: "me@example.com", eventTypeId: 5 },
      {
        id: "sc-other",
        userId: OTHER_USER_ID,
        integration: GOOGLE,
        externalId: "o@example.com",
        eventTypeId: null,
      },
    ];
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    membershipLookup.addMember({ teamId: TEAM_ID, userId: USER_ID });
    membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: USER_ID });
    membershipLookup.addMember({ teamId: PENDING_TEAM_ID, userId: USER_ID, accepted: false });
    flags = new Set(["notetaker", "notetaker-calendar-auto-join"]);
    supportedIntegrations = [GOOGLE];
    service = new NotetakerCalendarAutoJoinSettingsService({
      autoJoinRepository: repository,
      calendarEventsGatewayResolver: { supportedIntegrations: () => supportedIntegrations },
      eventTypeNotetakerSettingsRepository: {
        findTeamsByIds: async ({ teamIds }) =>
          teamIds.map((teamId) => ({ teamId, teamName: TEAM_NAMES[teamId] ?? `Team ${teamId}` })),
      },
      membershipLookup,
      featuresRepository: { checkIfUserHasFeature: async (_userId, slug) => flags.has(slug) },
    });
  });

  describe("list", () => {
    it.each([
      "notetaker",
      "notetaker-calendar-auto-join",
    ])("is unavailable with nothing listed when the %s flag is off", async (flag) => {
      flags.delete(flag);

      await expect(service.list({ userId: USER_ID })).resolves.toEqual({
        available: false,
        teamOptions: [],
        calendars: [],
      });
    });

    it("lists accepted teams only as team options", async () => {
      const { teamOptions } = await service.list({ userId: USER_ID });

      expect(teamOptions).toEqual([
        { teamId: TEAM_ID, name: "Sales" },
        { teamId: OTHER_TEAM_ID, name: "Support" },
      ]);
    });

    it("lists only the user's user-level calendars, off by default", async () => {
      const { available, calendars } = await service.list({ userId: USER_ID });

      expect(available).toBe(true);
      expect(calendars).toEqual([
        {
          selectedCalendarId: "sc-google",
          integration: GOOGLE,
          externalId: "me@example.com",
          enabled: false,
          sharingTeamId: null,
          supported: true,
          lastPollFailed: false,
        },
        {
          selectedCalendarId: "sc-office",
          integration: OFFICE,
          externalId: "me@outlook.com",
          enabled: false,
          sharingTeamId: null,
          supported: false,
          lastPollFailed: false,
        },
      ]);
    });

    it("reflects a stored row and flags a failed poll without exposing its message", async () => {
      repository.rows.set("sc-google", {
        selectedCalendarId: "sc-google",
        userId: USER_ID,
        enabled: true,
        sharingTeamId: TEAM_ID,
        lastPollError: "invalid_grant: token revoked",
      });

      const { calendars } = await service.list({ userId: USER_ID });

      expect(calendars[0]).toEqual({
        selectedCalendarId: "sc-google",
        integration: GOOGLE,
        externalId: "me@example.com",
        enabled: true,
        sharingTeamId: TEAM_ID,
        supported: true,
        lastPollFailed: true,
      });
      expect(JSON.stringify(calendars)).not.toContain("invalid_grant");
    });
  });

  describe("set", () => {
    it("creates the row with the sharing team", async () => {
      await service.set({
        userId: USER_ID,
        selectedCalendarId: "sc-google",
        enabled: true,
        sharingTeamId: TEAM_ID,
      });

      expect(repository.rows.get("sc-google")).toMatchObject({
        userId: USER_ID,
        enabled: true,
        sharingTeamId: TEAM_ID,
      });
    });

    it("updates an existing row to disabled without a team", async () => {
      await service.set({
        userId: USER_ID,
        selectedCalendarId: "sc-google",
        enabled: true,
        sharingTeamId: TEAM_ID,
      });

      await service.set({
        userId: USER_ID,
        selectedCalendarId: "sc-google",
        enabled: false,
        sharingTeamId: null,
      });

      expect(repository.rows.get("sc-google")).toMatchObject({ enabled: false, sharingTeamId: null });
    });

    it.each([
      "notetaker",
      "notetaker-calendar-auto-join",
    ])("is forbidden when the %s flag is off", async (flag) => {
      flags.delete(flag);

      await expectErrorCode(
        service.set({ userId: USER_ID, selectedCalendarId: "sc-google", enabled: true, sharingTeamId: null }),
        ErrorCode.Forbidden
      );
      expect(repository.rows.size).toBe(0);
    });

    it.each([
      ["another user's calendar", "sc-other"],
      ["an event-type calendar", "sc-event"],
      ["an unknown calendar", "sc-missing"],
    ])("is not found for %s", async (_label, selectedCalendarId) => {
      await expectErrorCode(
        service.set({ userId: USER_ID, selectedCalendarId, enabled: true, sharingTeamId: null }),
        ErrorCode.NotFound
      );
      expect(repository.rows.size).toBe(0);
    });

    it("rejects a calendar whose integration has no events gateway", async () => {
      await expectErrorCode(
        service.set({ userId: USER_ID, selectedCalendarId: "sc-office", enabled: true, sharingTeamId: null }),
        ErrorCode.BadRequest
      );
      expect(repository.rows.size).toBe(0);
    });

    it.each([
      ["a team the user is not in", 99],
      ["a team with a pending invite", PENDING_TEAM_ID],
    ])("is forbidden to share with %s", async (_label, sharingTeamId) => {
      await expectErrorCode(
        service.set({ userId: USER_ID, selectedCalendarId: "sc-google", enabled: true, sharingTeamId }),
        ErrorCode.Forbidden
      );
      expect(repository.rows.size).toBe(0);
    });
  });
});
