import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotetakerConfig } from "../lib/config";
import type { INotetakerUserLookup } from "../lib/userLookup";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerSharingSettingsService } from "./NotetakerSharingSettingsService";

const EVENT_TYPE_ID = 10;
const TEAM_ID = 20;
const ORGANIZATION_ID = 30;
const ACTOR_ID = 1;

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
    ...overrides,
  };
}

async function expectRejection(promise: Promise<unknown>, code: ErrorCode, message: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

describe("NotetakerSharingSettingsService", () => {
  const checkIfUserHasFeature = vi.fn(async (_userId: number, _slug: string): Promise<boolean> => true);
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let service: NotetakerSharingSettingsService;

  function buildService(config: NotetakerConfig = buildConfig()): NotetakerSharingSettingsService {
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) =>
        ids.map((id) => {
          const user = repositories.store.getUser(id);
          return { id, name: user.name, email: user.email, locale: null, timeZone: "UTC" };
        }),
    };
    return new NotetakerSharingSettingsService({
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
      featuresRepository: { checkIfUserHasFeature },
      userRepository,
      config,
    });
  }

  function seedEventType(overrides: { teamId?: number | null; organizationId?: number | null } = {}) {
    repositories.store.addEventType({
      id: EVENT_TYPE_ID,
      userId: null,
      teamId: TEAM_ID,
      locations: null,
      ownerName: null,
      title: "Planning",
      teamName: "Sales",
      organizationId: null,
      ...overrides,
    });
  }

  function addMembers(userIds: number[], teamId = TEAM_ID) {
    for (const userId of userIds) membershipLookup.addMember({ teamId, userId });
  }

  beforeEach(() => {
    checkIfUserHasFeature.mockReset();
    checkIfUserHasFeature.mockResolvedValue(true);
    repositories = createInMemoryNotetakerRepositories();
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    repositories.store.setUser(ACTOR_ID, { name: "Ada Admin", email: "ada@example.com", avatarUrl: null });
    repositories.store.setUser(2, { name: "Bob", email: "bob@example.com", avatarUrl: null });
    repositories.store.setUser(3, { name: null, email: "carol@example.com", avatarUrl: null });
    repositories.store.setUser(4, { name: "Dan", email: "dan@example.com", avatarUrl: null });
    service = buildService();
    seedEventType();
    addMembers([ACTOR_ID, 2, 3, 4]);
  });

  describe("get", () => {
    it("reports FEATURE_DISABLED before anything else", async () => {
      checkIfUserHasFeature.mockResolvedValue(false);
      seedEventType({ teamId: null });

      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result).toMatchObject({ available: false, unavailableReason: "FEATURE_DISABLED" });
    });

    it("reports FEATURE_DISABLED when the bot provider is not usable", async () => {
      service = buildService(buildConfig({ botProvider: null }));

      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result.unavailableReason).toBe("FEATURE_DISABLED");
    });

    it("reports NOT_A_TEAM_EVENT_TYPE with no mode, people or team name", async () => {
      seedEventType({ teamId: null });

      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result).toEqual({
        eventTypeId: EVENT_TYPE_ID,
        available: false,
        unavailableReason: "NOT_A_TEAM_EVENT_TYPE",
        mode: "HOSTS_ONLY",
        teamName: null,
        people: [],
        setAt: null,
        setByName: null,
      });
    });

    it("throws EVENT_TYPE_NOT_FOUND for an unknown event type", async () => {
      await expectRejection(
        service.get({ eventTypeId: 999, userId: ACTOR_ID }),
        ErrorCode.NotFound,
        "EVENT_TYPE_NOT_FOUND"
      );
    });

    it("defaults to HOSTS_ONLY and lists people with stillEligible after a member is removed", async () => {
      repositories.store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
      repositories.store.setSharingMembers(EVENT_TYPE_ID, [2, 3]);
      membershipLookup.removeMember({ teamId: TEAM_ID, userId: 3 });

      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result.available).toBe(true);
      expect(result.mode).toBe("SELECTED_PEOPLE");
      expect(result.teamName).toBe("Sales");
      expect(result.people.map((p) => [p.userId, p.stillEligible])).toEqual([
        [2, true],
        [3, false],
      ]);
    });

    it("returns the stamp with the name of whoever set it", async () => {
      await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID });

      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result.setByName).toBe("Ada Admin");
      expect(result.setAt).not.toBeNull();
    });

    it("checks eligibility against the organization when the team has one", async () => {
      seedEventType({ organizationId: ORGANIZATION_ID });
      addMembers([2], ORGANIZATION_ID);
      repositories.store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
      repositories.store.setSharingMembers(EVENT_TYPE_ID, [2, 3]);

      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result.people.map((p) => [p.userId, p.stillEligible])).toEqual([
        [2, true],
        [3, false],
      ]);
    });
  });

  describe("set", () => {
    it("refuses when the feature is disabled", async () => {
      checkIfUserHasFeature.mockResolvedValue(false);

      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID }),
        ErrorCode.Forbidden,
        "FEATURE_DISABLED"
      );
    });

    it("refuses a non-default mode on an event type without a team", async () => {
      seedEventType({ teamId: null });

      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "NOT_A_TEAM_EVENT_TYPE"
      );
    });

    it("refuses a list on an event type without a team", async () => {
      seedEventType({ teamId: null });

      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "HOSTS_ONLY", userIds: [2], userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "NOT_A_TEAM_EVENT_TYPE"
      );
    });

    it("returns the current state without writing for HOSTS_ONLY on an event type without a team", async () => {
      seedEventType({ teamId: null });

      const result = await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "HOSTS_ONLY", userId: ACTOR_ID });

      expect(result.unavailableReason).toBe("NOT_A_TEAM_EVENT_TYPE");
      expect(repositories.store.sharingChanges).toHaveLength(0);
      expect(repositories.store.eventTypeSettings.size).toBe(0);
    });

    it("refuses an actor who is not an accepted member of the team", async () => {
      membershipLookup.addMember({ teamId: TEAM_ID, userId: ACTOR_ID, accepted: false });

      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID }),
        ErrorCode.Forbidden,
        "NOT_ALLOWED"
      );
      expect(repositories.store.sharingChanges).toHaveLength(0);
    });

    it("throws EVENT_TYPE_NOT_FOUND for an unknown event type", async () => {
      await expectRejection(
        service.set({ eventTypeId: 999, mode: "TEAM", userId: ACTOR_ID }),
        ErrorCode.NotFound,
        "EVENT_TYPE_NOT_FOUND"
      );
    });

    it("refuses 51 people", async () => {
      const ids = Array.from({ length: 51 }, (_, i) => 100 + i);
      addMembers(ids);

      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "SELECTED_PEOPLE", userIds: ids, userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "TOO_MANY_PEOPLE"
      );
    });

    it("accepts 50 people and counts duplicates once", async () => {
      const ids = Array.from({ length: 50 }, (_, i) => 100 + i);
      addMembers(ids);

      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [...ids, 100],
        userId: ACTOR_ID,
      });

      expect(repositories.store.sharingMembers.get(EVENT_TYPE_ID)).toHaveLength(50);
    });

    it("refuses an outsider with a message that holds no id or name", async () => {
      repositories.store.setUser(77, { name: "Mallory Outsider", email: "m@example.com", avatarUrl: null });

      const attempt = service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2, 77],
        userId: ACTOR_ID,
      });

      await expectRejection(attempt, ErrorCode.BadRequest, "PERSON_NOT_ELIGIBLE");
      expect(repositories.store.sharingChanges).toHaveLength(0);
    });

    it("checks people against the organization when the team has one", async () => {
      seedEventType({ organizationId: ORGANIZATION_ID });
      addMembers([ACTOR_ID, 2], ORGANIZATION_ID);

      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2],
        userId: ACTOR_ID,
      });
      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "SELECTED_PEOPLE", userIds: [3], userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "PERSON_NOT_ELIGIBLE"
      );
    });

    it("writes one change row with added names, falling back to the email", async () => {
      const result = await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2, 3],
        userId: ACTOR_ID,
      });

      expect(result.mode).toBe("SELECTED_PEOPLE");
      expect(result.people.map((p) => p.userId)).toEqual([2, 3]);
      expect(repositories.store.sharingChanges).toHaveLength(1);
      expect(repositories.store.sharingChanges[0]).toMatchObject({
        eventTypeId: EVENT_TYPE_ID,
        actorUserId: ACTOR_ID,
        actorName: "Ada Admin",
        previousMode: "HOSTS_ONLY",
        newMode: "SELECTED_PEOPLE",
        addedUserNames: ["Bob", "carol@example.com"],
        removedUserNames: [],
      });
      expect(repositories.store.eventTypeSettings.get(EVENT_TYPE_ID)).toMatchObject({
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: ACTOR_ID,
      });
    });

    it("names added and removed people in one change row", async () => {
      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2, 3],
        userId: ACTOR_ID,
      });

      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [3, 4],
        userId: ACTOR_ID,
      });

      expect(repositories.store.sharingChanges).toHaveLength(2);
      expect(repositories.store.sharingChanges[1]).toMatchObject({
        previousMode: "SELECTED_PEOPLE",
        newMode: "SELECTED_PEOPLE",
        addedUserNames: ["Dan"],
        removedUserNames: ["Bob"],
      });
    });

    it("writes nothing when nothing changed", async () => {
      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2, 3],
        userId: ACTOR_ID,
      });
      const stamp = repositories.store.eventTypeSettings.get(EVENT_TYPE_ID)?.sharingSetAt;

      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [3, 2],
        userId: ACTOR_ID,
      });

      expect(repositories.store.sharingChanges).toHaveLength(1);
      expect(repositories.store.eventTypeSettings.get(EVENT_TYPE_ID)?.sharingSetAt).toBe(stamp);
    });

    it("writes nothing when setting the default mode again", async () => {
      await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "HOSTS_ONLY", userId: ACTOR_ID });

      expect(repositories.store.sharingChanges).toHaveLength(0);
      expect(repositories.store.eventTypeSettings.size).toBe(0);
    });

    it("keeps the list when userIds is omitted", async () => {
      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2, 3],
        userId: ACTOR_ID,
      });

      await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "SELECTED_PEOPLE", userId: ACTOR_ID });

      expect(repositories.store.sharingMembers.get(EVENT_TYPE_ID)?.map((m) => m.userId)).toEqual([2, 3]);
      expect(repositories.store.sharingChanges).toHaveLength(1);
    });

    it.each([
      "TEAM",
      "HOSTS_ONLY",
    ] as const)("keeps the list and ignores userIds when the mode is %s", async (mode) => {
      await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "SELECTED_PEOPLE",
        userIds: [2, 3],
        userId: ACTOR_ID,
      });

      await service.set({ eventTypeId: EVENT_TYPE_ID, mode, userIds: [4], userId: ACTOR_ID });

      expect(repositories.store.sharingMembers.get(EVENT_TYPE_ID)?.map((m) => m.userId)).toEqual([2, 3]);
      expect(repositories.store.sharingChanges).toHaveLength(2);
      expect(repositories.store.sharingChanges[1]).toMatchObject({
        previousMode: "SELECTED_PEOPLE",
        newMode: mode,
        addedUserNames: [],
        removedUserNames: [],
      });
    });

    it("does not validate ignored userIds", async () => {
      await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userIds: [999], userId: ACTOR_ID });

      expect(repositories.store.eventTypeSettings.get(EVENT_TYPE_ID)?.sharingMode).toBe("TEAM");
    });
  });

  describe("listCandidates", () => {
    it("refuses when the feature is disabled", async () => {
      checkIfUserHasFeature.mockResolvedValue(false);

      await expectRejection(
        service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID }),
        ErrorCode.Forbidden,
        "FEATURE_DISABLED"
      );
    });

    it("refuses an event type without a team", async () => {
      seedEventType({ teamId: null });

      await expectRejection(
        service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "NOT_A_TEAM_EVENT_TYPE"
      );
    });

    it("refuses an actor who is not an accepted member", async () => {
      membershipLookup.removeMember({ teamId: TEAM_ID, userId: ACTOR_ID });

      await expectRejection(
        service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID }),
        ErrorCode.Forbidden,
        "NOT_ALLOWED"
      );
    });

    it("lists the team members, without exposing more than the four fields", async () => {
      const result = await service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result.items.map((item) => item.userId)).toEqual([1, 2, 3, 4]);
      expect(Object.keys(result.items[0]).sort()).toEqual(["avatarUrl", "email", "name", "userId"]);
      expect(result.nextCursor).toBeNull();
    });

    it("lists the organization members when the team has an organization", async () => {
      seedEventType({ organizationId: ORGANIZATION_ID });
      addMembers([ACTOR_ID, 4], ORGANIZATION_ID);

      const result = await service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result.items.map((item) => item.userId)).toEqual([1, 4]);
    });

    it("searches case-insensitively and treats whitespace as no search", async () => {
      const found = await service.listCandidates({
        eventTypeId: EVENT_TYPE_ID,
        search: " USER2 ",
        userId: ACTOR_ID,
      });
      const blank = await service.listCandidates({
        eventTypeId: EVENT_TYPE_ID,
        search: "   ",
        userId: ACTOR_ID,
      });

      expect(found.items.map((item) => item.userId)).toEqual([2]);
      expect(blank.items).toHaveLength(4);
    });

    it("clamps the limit to 1..50 and defaults to 20", async () => {
      const ids = Array.from({ length: 60 }, (_, i) => 100 + i);
      addMembers(ids);

      const byDefault = await service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });
      const tooHigh = await service.listCandidates({
        eventTypeId: EVENT_TYPE_ID,
        limit: 500,
        userId: ACTOR_ID,
      });
      const tooLow = await service.listCandidates({ eventTypeId: EVENT_TYPE_ID, limit: 0, userId: ACTOR_ID });

      expect(byDefault.items).toHaveLength(20);
      expect(tooHigh.items).toHaveLength(50);
      expect(tooLow.items).toHaveLength(1);
    });

    it("pages with the cursor", async () => {
      const first = await service.listCandidates({ eventTypeId: EVENT_TYPE_ID, limit: 2, userId: ACTOR_ID });
      const second = await service.listCandidates({
        eventTypeId: EVENT_TYPE_ID,
        limit: 2,
        cursor: first.nextCursor,
        userId: ACTOR_ID,
      });

      expect(first.items.map((item) => item.userId)).toEqual([1, 2]);
      expect(second.items.map((item) => item.userId)).toEqual([3, 4]);
    });
  });
});
