// Cross-organization isolation suite (FR-008). Every refusal below comes from the services'
// own checks against one shared in-memory store, never from a stubbed return value.
//
// availability.listTeam, OOO toTeamUserId and webhook team create have no service layer: they
// live only in tRPC handlers that use the prisma singleton, which packages/features must not
// import. Their isolation tests sit next to those handlers, under
// packages/trpc/server/routers/viewer/availability/team/, .../ooo/ and .../webhook/.
import { EventTypeHostService } from "@calcom/features/host/services/EventTypeHostService";
import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";
import { NotetakerSharingSettingsService } from "@calcom/features/notetaker/services/NotetakerSharingSettingsService";
import { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotetakerConfig } from "../../notetaker/lib/config";
import {
  ADAM,
  ALICE,
  BEA,
  BOB,
  EVENT_TYPE_A,
  type InMemoryIsolationWorld,
  ORG_A,
  ORG_B,
  seedTwoOrgs,
  TEAM_A,
} from "./InMemoryIsolationWorld";

vi.mock("@calcom/prisma", () => ({ prisma: {}, default: {} }));

async function expectErrorCode(promise: Promise<unknown>, code: ErrorCode, message?: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(code);
  if (message !== undefined) expect(error.message).toBe(message);
}

function buildServices(world: InMemoryIsolationWorld) {
  const teamMembers = new TeamMembersService(
    world.membershipRepository(),
    world.teamRepository(),
    world.userRepository(),
    vi.fn(async () => undefined),
    () => world.organizationMembershipService()
  );
  const organizationMembership = world.organizationMembershipService();
  const teamProfile = new TeamProfileService(world.teamProfilePrisma(), undefined, (userId, organizationId) =>
    organizationMembership.getRole(userId, organizationId)
  );
  const eventTypeHosts = new EventTypeHostService({} as never, world.eventTypeHostDeps());
  return { teamMembers, teamProfile, eventTypeHosts };
}

function buildNotetakerService(world: InMemoryIsolationWorld) {
  const { repositories, membershipLookup } = world.notetakerFakes();
  return new NotetakerSharingSettingsService({
    eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
    membershipLookup,
    featuresRepository: { checkIfUserHasFeature: async () => true },
    userRepository: {
      findByIds: async ({ ids }) =>
        ids.map((id) => {
          const user = world.user(id);
          return { id, name: user?.name ?? null, email: user?.email ?? "", locale: null, timeZone: "UTC" };
        }),
    },
    // Only botProvider matters here: it makes the feature usable without a real bot.
    config: { botProvider: "FAKE" } as NotetakerConfig,
  });
}

describe("cross-organization isolation", () => {
  let world: InMemoryIsolationWorld;
  let services: ReturnType<typeof buildServices>;

  const orgIdOf = (userId: number) => world.user(userId)?.organizationId;

  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    world = seedTwoOrgs();
    services = buildServices(world);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("teams", () => {
    it("refuses another organization's team as not found", async () => {
      await expectErrorCode(
        services.teamMembers.getTeam({ teamId: TEAM_A, viewerId: BOB }),
        ErrorCode.NotFound
      );
      await expectErrorCode(
        services.teamMembers.listMembers({ teamId: TEAM_A, viewerId: BOB }),
        ErrorCode.NotFound
      );
      await expectErrorCode(
        services.teamProfile.getTeamProfile({ teamId: TEAM_A, userId: BOB }),
        ErrorCode.NotFound
      );
    });

    it("lists only the team's own organization members", async () => {
      const result = await services.teamMembers.listMembers({ teamId: TEAM_A, viewerId: ALICE });

      expect(result.items.map((item) => item.user.id)).toEqual([ALICE, ADAM]);
      expect(result.items.every((item) => orgIdOf(item.user.id) === ORG_A)).toBe(true);
      expect(result.total).toBe(2);
    });

    it("refuses an invite into another organization's team as not found", async () => {
      await expectErrorCode(
        services.teamMembers.inviteMember({
          teamId: TEAM_A,
          requesterId: BOB,
          requesterName: "Bob",
          email: "someone@new.test",
          role: MembershipRole.MEMBER,
        }),
        ErrorCode.NotFound
      );
      expect(world.users.some((user) => user.email === "someone@new.test")).toBe(false);
    });

    it("refuses inviting a user who belongs to another organization and leaves them untouched", async () => {
      await expectErrorCode(
        services.teamMembers.inviteMember({
          teamId: TEAM_A,
          requesterId: ALICE,
          requesterName: "Alice",
          email: "bea@bolt.test",
          role: MembershipRole.MEMBER,
        }),
        ErrorCode.Conflict,
        "user_belongs_to_another_organization"
      );
      expect(world.membership(BEA, TEAM_A)).toBeNull();
      expect(orgIdOf(BEA)).toBe(ORG_B);
      expect(world.inviteTokens).toEqual([]);
    });
  });

  describe("event type hosts", () => {
    it("searches team members only for members of the team's organization", async () => {
      await expectErrorCode(
        services.eventTypeHosts.searchTeamMembers({ teamId: TEAM_A, userId: BOB, limit: 10 }),
        ErrorCode.NotFound
      );

      const result = await services.eventTypeHosts.searchTeamMembers({
        teamId: TEAM_A,
        userId: ALICE,
        limit: 10,
      });

      expect(result.members.map((member) => member.userId)).toEqual([ALICE, ADAM]);
      expect(result.members.every((member) => orgIdOf(member.userId) === ORG_A)).toBe(true);
    });

    it("refuses hosts from another organization as not found", async () => {
      await expectErrorCode(
        services.eventTypeHosts.assertHostsInTeamOrganization({ teamId: TEAM_A, hostUserIds: [ALICE, BEA] }),
        ErrorCode.NotFound
      );
      await expect(
        services.eventTypeHosts.assertHostsInTeamOrganization({ teamId: TEAM_A, hostUserIds: [ALICE, ADAM] })
      ).resolves.toBeUndefined();
    });

    it("returns no hosts from another organization for assignment", async () => {
      const result = await services.eventTypeHosts.getHostsForAssignment({
        eventTypeId: EVENT_TYPE_A,
        limit: 20,
      });

      expect(result.hosts.map((host) => host.userId)).toEqual([ALICE]);
      expect(result.hosts.some((host) => orgIdOf(host.userId) === ORG_B)).toBe(false);
    });
  });

  describe("notetaker sharing candidates", () => {
    it("refuses an actor from another organization and lists only the event type's organization", async () => {
      const notetaker = buildNotetakerService(world);

      await expectErrorCode(
        notetaker.listCandidates({ eventTypeId: EVENT_TYPE_A, userId: BOB }),
        ErrorCode.NotFound,
        "Team not found"
      );

      const result = await notetaker.listCandidates({ eventTypeId: EVENT_TYPE_A, userId: ALICE });
      const candidateIds = result.items.map((item) => item.userId);

      expect(candidateIds).toEqual([ALICE, ADAM]);
      expect(candidateIds).not.toContain(BEA);
      expect(candidateIds).not.toContain(BOB);
    });
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
    });

    it("keeps the pre-organization forbidden response for non-members", async () => {
      await expectErrorCode(
        services.teamMembers.getTeam({ teamId: TEAM_A, viewerId: BOB }),
        ErrorCode.Forbidden
      );
    });

    it("does not check host organizations", async () => {
      await expect(
        services.eventTypeHosts.assertHostsInTeamOrganization({ teamId: TEAM_A, hostUserIds: [ALICE, BEA] })
      ).resolves.toBeUndefined();
    });
  });
});
