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
const OTHER_TEAM_ID = 21;
const PENDING_TEAM_ID = 22;
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

  function seedEventType(
    overrides: {
      userId?: number | null;
      teamId?: number | null;
      teamName?: string | null;
      organizationId?: number | null;
    } = {}
  ) {
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
        teamId: null,
        teamOptions: [],
      });
    });

    it("returns the owning team and no team options for a team event type", async () => {
      const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

      expect(result).toMatchObject({
        available: true,
        unavailableReason: null,
        teamId: TEAM_ID,
        teamName: "Sales",
        teamOptions: [],
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

    it("refuses a team other than the owning one on a team event type", async () => {
      repositories.store.setTeam(OTHER_TEAM_ID, "Design");
      addMembers([ACTOR_ID], OTHER_TEAM_ID);

      await expectRejection(
        service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: OTHER_TEAM_ID, userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "TEAM_NOT_ALLOWED"
      );
      expect(repositories.store.sharingChanges).toHaveLength(0);
    });

    it("accepts the owning team on a team event type and clears a stale chosen team", async () => {
      repositories.store.setTeam(OTHER_TEAM_ID, "Design");
      repositories.store.setSharingTeam(EVENT_TYPE_ID, OTHER_TEAM_ID);
      const updateSharing = vi.spyOn(repositories.eventTypeNotetakerSettingsRepository, "updateSharing");

      const result = await service.set({
        eventTypeId: EVENT_TYPE_ID,
        mode: "TEAM",
        teamId: TEAM_ID,
        userId: ACTOR_ID,
      });

      expect(updateSharing).toHaveBeenCalledTimes(1);
      expect(updateSharing).toHaveBeenCalledWith(
        expect.objectContaining({
          sharingTeamId: null,
          change: expect.objectContaining({ previousTeamName: "Sales", newTeamName: "Sales" }),
        })
      );
      expect(repositories.store.eventTypeSettings.get(EVENT_TYPE_ID)?.sharingTeamId).toBeNull();
      expect(result).toMatchObject({ mode: "TEAM", teamId: TEAM_ID, teamName: "Sales" });
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

    it("refuses a team other than the owning one on a team event type", async () => {
      repositories.store.setTeam(OTHER_TEAM_ID, "Design");
      addMembers([ACTOR_ID, 5], OTHER_TEAM_ID);

      await expectRejection(
        service.listCandidates({ eventTypeId: EVENT_TYPE_ID, teamId: OTHER_TEAM_ID, userId: ACTOR_ID }),
        ErrorCode.BadRequest,
        "TEAM_NOT_ALLOWED"
      );
    });

    it("ignores the owning team passed for a team event type", async () => {
      const result = await service.listCandidates({
        eventTypeId: EVENT_TYPE_ID,
        teamId: TEAM_ID,
        userId: ACTOR_ID,
      });

      expect(result.items.map((item) => item.userId)).toEqual([1, 2, 3, 4]);
    });
  });

  describe("personal event type", () => {
    const SALES = { teamId: TEAM_ID, name: "Sales" };
    const DESIGN = { teamId: OTHER_TEAM_ID, name: "Design" };

    function storedSettings() {
      return repositories.store.eventTypeSettings.get(EVENT_TYPE_ID);
    }

    function storedMemberIds() {
      return repositories.store.sharingMembers.get(EVENT_TYPE_ID)?.map((member) => member.userId);
    }

    function leaveEveryTeam() {
      membershipLookup.removeMember({ teamId: TEAM_ID, userId: ACTOR_ID });
      membershipLookup.removeMember({ teamId: OTHER_TEAM_ID, userId: ACTOR_ID });
    }

    beforeEach(() => {
      seedEventType({ userId: ACTOR_ID, teamId: null, teamName: null });
      repositories.store.setUser(5, { name: "Eve", email: "eve@example.com", avatarUrl: null });
      repositories.store.setTeam(TEAM_ID, "Sales");
      repositories.store.setTeam(OTHER_TEAM_ID, "Design");
      repositories.store.setTeam(PENDING_TEAM_ID, "Alpha");
      addMembers([ACTOR_ID, 4, 5], OTHER_TEAM_ID);
      membershipLookup.addMember({ teamId: PENDING_TEAM_ID, userId: ACTOR_ID, accepted: false });
      addMembers([2], PENDING_TEAM_ID);
    });

    describe("get", () => {
      it("reports NO_TEAM_TO_SHARE_WITH when the owner is in no team", async () => {
        leaveEveryTeam();
        repositories.store.setSharingMode(EVENT_TYPE_ID, "TEAM");
        repositories.store.setSharingMembers(EVENT_TYPE_ID, [2]);

        const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result).toEqual({
          eventTypeId: EVENT_TYPE_ID,
          available: false,
          unavailableReason: "NO_TEAM_TO_SHARE_WITH",
          mode: "HOSTS_ONLY",
          teamName: null,
          people: [],
          setAt: null,
          setByName: null,
          teamId: null,
          teamOptions: [],
        });
      });

      it("reports FEATURE_DISABLED to the owner before the missing team", async () => {
        checkIfUserHasFeature.mockResolvedValue(false);
        leaveEveryTeam();

        const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result).toMatchObject({ available: false, unavailableReason: "FEATURE_DISABLED" });
      });

      it("offers the owner's accepted teams by name then id, without organizations or pending invitations", async () => {
        repositories.store.setTeam(19, "Sales");
        addMembers([ACTOR_ID], 19);
        // An organization is never registered as a team: findTeamsByIds leaves organizations out.
        addMembers([ACTOR_ID], ORGANIZATION_ID);

        const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result).toEqual({
          eventTypeId: EVENT_TYPE_ID,
          available: true,
          unavailableReason: null,
          mode: "HOSTS_ONLY",
          teamName: null,
          people: [],
          setAt: null,
          setByName: null,
          teamId: null,
          teamOptions: [DESIGN, { teamId: 19, name: "Sales" }, SALES],
        });
      });

      it("returns the stored team and checks the people against it", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, OTHER_TEAM_ID);
        repositories.store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        repositories.store.setSharingMembers(EVENT_TYPE_ID, [2, 4]);

        const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result).toMatchObject({
          available: true,
          mode: "SELECTED_PEOPLE",
          teamId: OTHER_TEAM_ID,
          teamName: "Design",
          teamOptions: [DESIGN, SALES],
        });
        expect(result.people.map((p) => [p.userId, p.stillEligible])).toEqual([
          [2, false],
          [4, true],
        ]);
      });

      it("keeps the stored mode but no team and no people after the owner left the stored team", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, OTHER_TEAM_ID);
        repositories.store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        repositories.store.setSharingMembers(EVENT_TYPE_ID, [4]);
        membershipLookup.removeMember({ teamId: OTHER_TEAM_ID, userId: ACTOR_ID });

        const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result).toMatchObject({
          available: true,
          unavailableReason: null,
          mode: "SELECTED_PEOPLE",
          teamId: null,
          teamName: null,
          people: [],
          teamOptions: [SALES],
        });
      });

      it("keeps the stored mode but no team after the stored team was deleted", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, OTHER_TEAM_ID);
        repositories.store.setSharingMode(EVENT_TYPE_ID, "TEAM");
        repositories.store.removeTeam(OTHER_TEAM_ID);

        const result = await service.get({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result).toMatchObject({ mode: "TEAM", teamId: null, teamName: null, teamOptions: [SALES] });
      });

      it("refuses an actor who is not the owner, even a member of the chosen team", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, TEAM_ID);

        await expectRejection(
          service.get({ eventTypeId: EVENT_TYPE_ID, userId: 2 }),
          ErrorCode.Forbidden,
          "NOT_ALLOWED"
        );
      });

      it("refuses an actor who is not the owner while the feature is disabled", async () => {
        checkIfUserHasFeature.mockResolvedValue(false);

        await expectRejection(
          service.get({ eventTypeId: EVENT_TYPE_ID, userId: 2 }),
          ErrorCode.Forbidden,
          "NOT_ALLOWED"
        );
      });
    });

    describe("set", () => {
      it("refuses an actor who is not the owner", async () => {
        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: 2 }),
          ErrorCode.Forbidden,
          "NOT_ALLOWED"
        );
        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "HOSTS_ONLY", userId: 2 }),
          ErrorCode.Forbidden,
          "NOT_ALLOWED"
        );
        expect(repositories.store.sharingChanges).toHaveLength(0);
        expect(repositories.store.eventTypeSettings.size).toBe(0);
      });

      it.each(["TEAM", "SELECTED_PEOPLE"] as const)("refuses %s without a team", async (mode) => {
        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode, userIds: [2], userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_REQUIRED"
        );
        expect(repositories.store.sharingChanges).toHaveLength(0);
      });

      it("refuses a mode when the stored team is no longer one of the owner's teams", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, OTHER_TEAM_ID);
        membershipLookup.removeMember({ teamId: OTHER_TEAM_ID, userId: ACTOR_ID });

        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_REQUIRED"
        );
        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: OTHER_TEAM_ID, userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_NOT_ALLOWED"
        );
        expect(repositories.store.sharingChanges).toHaveLength(0);
      });

      it.each([
        ["an unknown team", 999],
        ["a team whose invitation the owner has not accepted", PENDING_TEAM_ID],
        ["an organization the owner belongs to", ORGANIZATION_ID],
      ])("refuses %s, for every mode", async (_label, teamId) => {
        addMembers([ACTOR_ID], ORGANIZATION_ID);

        for (const mode of ["TEAM", "SELECTED_PEOPLE", "HOSTS_ONLY"] as const) {
          await expectRejection(
            service.set({ eventTypeId: EVENT_TYPE_ID, mode, teamId, userId: ACTOR_ID }),
            ErrorCode.BadRequest,
            "TEAM_NOT_ALLOWED"
          );
        }
        expect(repositories.store.sharingChanges).toHaveLength(0);
        expect(repositories.store.eventTypeSettings.size).toBe(0);
      });

      it("refuses sharing when the owner is in no team", async () => {
        leaveEveryTeam();

        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "NO_TEAM_TO_SHARE_WITH"
        );
        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "NO_TEAM_TO_SHARE_WITH"
        );
        await expectRejection(
          service.set({ eventTypeId: EVENT_TYPE_ID, mode: "HOSTS_ONLY", userIds: [2], userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "NO_TEAM_TO_SHARE_WITH"
        );
      });

      it("returns the state without writing for HOSTS_ONLY when the owner is in no team", async () => {
        leaveEveryTeam();

        const result = await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "HOSTS_ONLY",
          userId: ACTOR_ID,
        });

        expect(result.unavailableReason).toBe("NO_TEAM_TO_SHARE_WITH");
        expect(repositories.store.sharingChanges).toHaveLength(0);
        expect(repositories.store.eventTypeSettings.size).toBe(0);
      });

      it("stores team and mode on the first save and writes one row with the team name", async () => {
        const result = await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "TEAM",
          teamId: TEAM_ID,
          userId: ACTOR_ID,
        });

        expect(result).toMatchObject({ available: true, mode: "TEAM", teamId: TEAM_ID, teamName: "Sales" });
        expect(storedSettings()).toMatchObject({
          sharingMode: "TEAM",
          sharingTeamId: TEAM_ID,
          sharingSetByUserId: ACTOR_ID,
        });
        expect(repositories.store.sharingChanges).toHaveLength(1);
        expect(repositories.store.sharingChanges[0]).toMatchObject({
          actorUserId: ACTOR_ID,
          previousMode: "HOSTS_ONLY",
          newMode: "TEAM",
          addedUserNames: [],
          removedUserNames: [],
          previousTeamName: null,
          newTeamName: "Sales",
        });
      });

      it("writes nothing for HOSTS_ONLY without a team on an untouched event type", async () => {
        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "HOSTS_ONLY", userId: ACTOR_ID });

        expect(repositories.store.sharingChanges).toHaveLength(0);
        expect(repositories.store.eventTypeSettings.size).toBe(0);
      });

      it("uses the stored team when teamId is omitted", async () => {
        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: ACTOR_ID });

        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          userIds: [2, 3],
          userId: ACTOR_ID,
        });

        expect(storedSettings()).toMatchObject({ sharingMode: "SELECTED_PEOPLE", sharingTeamId: TEAM_ID });
        expect(storedMemberIds()).toEqual([2, 3]);
        expect(repositories.store.sharingChanges[1]).toMatchObject({
          previousTeamName: "Sales",
          newTeamName: "Sales",
          addedUserNames: ["Bob", "carol@example.com"],
        });
      });

      it("accepts the owner as a selected person", async () => {
        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: TEAM_ID,
          userIds: [ACTOR_ID],
          userId: ACTOR_ID,
        });

        expect(storedMemberIds()).toEqual([ACTOR_ID]);
      });

      it("refuses a person outside the chosen team, even a member of another team of the owner", async () => {
        await expectRejection(
          service.set({
            eventTypeId: EVENT_TYPE_ID,
            mode: "SELECTED_PEOPLE",
            teamId: OTHER_TEAM_ID,
            userIds: [4, 2],
            userId: ACTOR_ID,
          }),
          ErrorCode.BadRequest,
          "PERSON_NOT_ELIGIBLE"
        );
        expect(repositories.store.sharingChanges).toHaveLength(0);
        expect(repositories.store.eventTypeSettings.size).toBe(0);
      });

      it("replaces the list on a team change and checks the new people against the new team", async () => {
        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: TEAM_ID,
          userIds: [2, 3, 4],
          userId: ACTOR_ID,
        });

        await expectRejection(
          service.set({
            eventTypeId: EVENT_TYPE_ID,
            mode: "SELECTED_PEOPLE",
            teamId: OTHER_TEAM_ID,
            userIds: [2],
            userId: ACTOR_ID,
          }),
          ErrorCode.BadRequest,
          "PERSON_NOT_ELIGIBLE"
        );
        expect(storedSettings()?.sharingTeamId).toBe(TEAM_ID);
        expect(storedMemberIds()).toEqual([2, 3, 4]);

        const result = await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: OTHER_TEAM_ID,
          userIds: [4, 5],
          userId: ACTOR_ID,
        });

        expect(result).toMatchObject({ teamId: OTHER_TEAM_ID, teamName: "Design" });
        expect(result.people.map((p) => [p.userId, p.stillEligible])).toEqual([
          [4, true],
          [5, true],
        ]);
        expect(storedSettings()?.sharingTeamId).toBe(OTHER_TEAM_ID);
        expect(repositories.store.sharingChanges).toHaveLength(2);
        expect(repositories.store.sharingChanges[1]).toMatchObject({
          previousMode: "SELECTED_PEOPLE",
          newMode: "SELECTED_PEOPLE",
          addedUserNames: ["Eve"],
          removedUserNames: ["Bob", "carol@example.com"],
          previousTeamName: "Sales",
          newTeamName: "Design",
        });
      });

      it("empties the list on a team change without userIds and names the removed people", async () => {
        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: TEAM_ID,
          userIds: [2, 4],
          userId: ACTOR_ID,
        });

        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: OTHER_TEAM_ID,
          userId: ACTOR_ID,
        });

        // User 4 is in both teams and is removed all the same: a list is never carried to another team.
        expect(storedMemberIds()).toEqual([]);
        expect(repositories.store.sharingChanges[1]).toMatchObject({
          addedUserNames: [],
          removedUserNames: ["Bob", "Dan"],
          previousTeamName: "Sales",
          newTeamName: "Design",
        });
      });

      it("empties the list on a team change to the whole-team mode and ignores userIds", async () => {
        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: TEAM_ID,
          userIds: [2],
          userId: ACTOR_ID,
        });

        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "TEAM",
          teamId: OTHER_TEAM_ID,
          userIds: [5],
          userId: ACTOR_ID,
        });

        expect(storedMemberIds()).toEqual([]);
        expect(repositories.store.sharingChanges[1]).toMatchObject({
          previousMode: "SELECTED_PEOPLE",
          newMode: "TEAM",
          addedUserNames: [],
          removedUserNames: ["Bob"],
        });
      });

      it("writes a row for a change of team alone", async () => {
        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: ACTOR_ID });

        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "TEAM",
          teamId: OTHER_TEAM_ID,
          userId: ACTOR_ID,
        });

        expect(storedSettings()?.sharingTeamId).toBe(OTHER_TEAM_ID);
        expect(repositories.store.sharingChanges).toHaveLength(2);
        expect(repositories.store.sharingChanges[1]).toMatchObject({
          previousMode: "TEAM",
          newMode: "TEAM",
          addedUserNames: [],
          removedUserNames: [],
          previousTeamName: "Sales",
          newTeamName: "Design",
        });
      });

      it("writes nothing for the same team and the same mode", async () => {
        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: ACTOR_ID });
        const stamp = storedSettings()?.sharingSetAt;

        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: ACTOR_ID });
        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", userId: ACTOR_ID });

        expect(repositories.store.sharingChanges).toHaveLength(1);
        expect(storedSettings()?.sharingSetAt).toBe(stamp);
      });

      it("lets the owner save HOSTS_ONLY after leaving the stored team", async () => {
        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "SELECTED_PEOPLE",
          teamId: TEAM_ID,
          userIds: [2],
          userId: ACTOR_ID,
        });
        membershipLookup.removeMember({ teamId: TEAM_ID, userId: ACTOR_ID });

        const result = await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "HOSTS_ONLY",
          userId: ACTOR_ID,
        });

        expect(result).toMatchObject({ mode: "HOSTS_ONLY", teamId: null, teamName: null, people: [] });
        expect(storedSettings()).toMatchObject({ sharingMode: "HOSTS_ONLY", sharingTeamId: null });
        expect(storedMemberIds()).toEqual([]);
        expect(repositories.store.sharingChanges).toHaveLength(2);
        expect(repositories.store.sharingChanges[1]).toMatchObject({
          previousMode: "SELECTED_PEOPLE",
          newMode: "HOSTS_ONLY",
          removedUserNames: ["Bob"],
          previousTeamName: "Sales",
          newTeamName: null,
        });
      });

      it("records no earlier team once the stored team was deleted", async () => {
        await service.set({ eventTypeId: EVENT_TYPE_ID, mode: "TEAM", teamId: TEAM_ID, userId: ACTOR_ID });
        repositories.store.removeTeam(TEAM_ID);

        await service.set({
          eventTypeId: EVENT_TYPE_ID,
          mode: "TEAM",
          teamId: OTHER_TEAM_ID,
          userId: ACTOR_ID,
        });

        expect(repositories.store.sharingChanges[1]).toMatchObject({
          previousMode: "TEAM",
          newMode: "TEAM",
          previousTeamName: null,
          newTeamName: "Design",
        });
      });
    });

    describe("listCandidates", () => {
      it("lists the members of the team chosen in the draft, the owner included", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, TEAM_ID);

        const result = await service.listCandidates({
          eventTypeId: EVENT_TYPE_ID,
          teamId: OTHER_TEAM_ID,
          userId: ACTOR_ID,
        });

        expect(result.items.map((item) => item.userId)).toEqual([1, 4, 5]);
      });

      it("defaults to the stored team", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, TEAM_ID);

        const result = await service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID });

        expect(result.items.map((item) => item.userId)).toEqual([1, 2, 3, 4]);
      });

      it("refuses without a team", async () => {
        await expectRejection(
          service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_REQUIRED"
        );
      });

      it("refuses the stored team once the owner left it", async () => {
        repositories.store.setSharingTeam(EVENT_TYPE_ID, OTHER_TEAM_ID);
        membershipLookup.removeMember({ teamId: OTHER_TEAM_ID, userId: ACTOR_ID });

        await expectRejection(
          service.listCandidates({ eventTypeId: EVENT_TYPE_ID, userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_REQUIRED"
        );
        await expectRejection(
          service.listCandidates({ eventTypeId: EVENT_TYPE_ID, teamId: OTHER_TEAM_ID, userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_NOT_ALLOWED"
        );
      });

      it.each([
        ["an unknown team", 999],
        ["a team whose invitation the owner has not accepted", PENDING_TEAM_ID],
      ])("refuses %s", async (_label, teamId) => {
        await expectRejection(
          service.listCandidates({ eventTypeId: EVENT_TYPE_ID, teamId, userId: ACTOR_ID }),
          ErrorCode.BadRequest,
          "TEAM_NOT_ALLOWED"
        );
      });

      it("refuses an actor who is not the owner, even a member of the team asked for", async () => {
        await expectRejection(
          service.listCandidates({ eventTypeId: EVENT_TYPE_ID, teamId: TEAM_ID, userId: 2 }),
          ErrorCode.Forbidden,
          "NOT_ALLOWED"
        );
      });
    });
  });
});
