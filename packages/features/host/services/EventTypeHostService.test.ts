import { ErrorWithCode } from "@calcom/lib/errors";
import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the repositories and external dependencies
vi.mock("@calcom/features/host/repositories/HostRepository");
vi.mock("@calcom/features/membership/repositories/MembershipRepository");
vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository");
vi.mock("@calcom/features/teams/repositories/TeamRepository");
vi.mock("@calcom/features/users/repositories/UserRepository");

import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { EventTypeHostService } from "./EventTypeHostService";

const mockPrisma = {} as never;

function createService() {
  return new EventTypeHostService(mockPrisma);
}

function getHostRepoInstance(): InstanceType<typeof HostRepository> {
  return (HostRepository as unknown as { mock: { instances: InstanceType<typeof HostRepository>[] } }).mock
    .instances[0];
}

function getMembershipRepoInstance(): InstanceType<typeof MembershipRepository> {
  return (
    MembershipRepository as unknown as {
      mock: { instances: InstanceType<typeof MembershipRepository>[] };
    }
  ).mock.instances[0];
}

function getEventTypeRepoInstance(): InstanceType<typeof EventTypeRepository> {
  return (
    EventTypeRepository as unknown as {
      mock: { instances: InstanceType<typeof EventTypeRepository>[] };
    }
  ).mock.instances[0];
}

type TeamBasic = {
  id: number;
  name: string;
  slug: string | null;
  logoUrl: string | null;
  isOrganization: boolean;
  parentId: number | null;
};

function createOrgService({
  team,
  users = [],
}: {
  team: TeamBasic | null;
  users?: { id: number; organizationId: number | null }[];
}) {
  const teamRepository = { findBasicById: vi.fn().mockResolvedValue(team) };
  const userRepository = { findOrganizationIdsByIds: vi.fn().mockResolvedValue(users) };
  const service = new EventTypeHostService(mockPrisma, { teamRepository, userRepository });
  return { service, teamRepository, userRepository };
}

function buildTeam(overrides: Partial<TeamBasic> = {}): TeamBasic {
  return {
    id: 10,
    name: "Team",
    slug: "team",
    logoUrl: null,
    isOrganization: false,
    parentId: 100,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("EventTypeHostService", () => {
  describe("getHostsForAvailability", () => {
    it("should map repository items to AvailabilityHost DTOs", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findHostsPaginatedIncludeUser).mockResolvedValue({
        items: [
          {
            userId: 1,
            isFixed: true,
            priority: 2,
            weight: 150,
            scheduleId: 10,
            groupId: "g1",
            user: { name: "Alice", avatarUrl: "https://example.com/alice.png", timeZone: "UTC" },
          },
        ],
        nextCursor: undefined,
        hasMore: false,
      });

      const result = await service.getHostsForAvailability({
        eventTypeId: 100,
        limit: 20,
      });

      expect(hostRepo.findHostsPaginatedIncludeUser).toHaveBeenCalledWith({
        eventTypeId: 100,
        cursor: undefined,
        limit: 20,
        search: undefined,
      });
      expect(result.hosts).toHaveLength(1);
      expect(result.hosts[0]).toEqual({
        userId: 1,
        isFixed: true,
        priority: 2,
        weight: 150,
        scheduleId: 10,
        groupId: "g1",
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      });
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });

    it("should default priority to 0 and weight to 100 when null", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findHostsPaginatedIncludeUser).mockResolvedValue({
        items: [
          {
            userId: 2,
            isFixed: false,
            priority: null,
            weight: null,
            scheduleId: null,
            groupId: null,
            user: { name: null, avatarUrl: null, timeZone: "UTC" },
          },
        ],
        nextCursor: undefined,
        hasMore: false,
      });

      const result = await service.getHostsForAvailability({ eventTypeId: 1, limit: 10 });

      expect(result.hosts[0].priority).toBe(0);
      expect(result.hosts[0].weight).toBe(100);
    });

    it("should pass pagination params through", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findHostsPaginatedIncludeUser).mockResolvedValue({
        items: [],
        nextCursor: undefined,
        hasMore: false,
      });

      await service.getHostsForAvailability({
        eventTypeId: 5,
        cursor: 42,
        limit: 10,
        search: "test",
      });

      expect(hostRepo.findHostsPaginatedIncludeUser).toHaveBeenCalledWith({
        eventTypeId: 5,
        cursor: 42,
        limit: 10,
        search: "test",
      });
    });
  });

  describe("getHostsForAssignment", () => {
    it("should map repository items to AssignmentHost DTOs with email", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findHostsPaginatedIncludeUserForAssignment).mockResolvedValue({
        items: [
          {
            userId: 1,
            isFixed: false,
            priority: 3,
            weight: 200,
            scheduleId: null,
            groupId: null,
            user: { name: "Bob", email: "bob@test.com", avatarUrl: null },
          },
        ],
        nextCursor: undefined,
        hasMore: false,
        hasFixedHosts: false,
      });

      const result = await service.getHostsForAssignment({
        eventTypeId: 100,
        limit: 20,
      });

      expect(result.hosts[0].email).toBe("bob@test.com");
      expect(result.hosts[0].name).toBe("Bob");
      expect(result.hasFixedHosts).toBe(false);
    });

    it("should include hasFixedHosts only when defined", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findHostsPaginatedIncludeUserForAssignment).mockResolvedValue({
        items: [],
        nextCursor: undefined,
        hasMore: false,
        hasFixedHosts: undefined,
      });

      const result = await service.getHostsForAssignment({
        eventTypeId: 100,
        limit: 20,
      });

      expect(result).not.toHaveProperty("hasFixedHosts");
    });

    it("should pass memberUserIds to repository", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findHostsPaginatedIncludeUserForAssignment).mockResolvedValue({
        items: [],
        nextCursor: undefined,
        hasMore: false,
        hasFixedHosts: undefined,
      });

      await service.getHostsForAssignment({
        eventTypeId: 1,
        limit: 10,
        memberUserIds: [1, 2, 3],
      });

      expect(hostRepo.findHostsPaginatedIncludeUserForAssignment).toHaveBeenCalledWith(
        expect.objectContaining({ memberUserIds: [1, 2, 3] })
      );
    });
  });

  describe("getChildrenForAssignment", () => {
    it("should map and filter children with null owners", async () => {
      const service = createService();
      const hostRepo = getHostRepoInstance();

      vi.mocked(hostRepo.findChildrenForAssignmentPaginated).mockResolvedValue({
        items: [
          {
            id: 10,
            slug: "child-1",
            hidden: false,
            owner: { id: 1, name: "Alice", email: "alice@test.com", username: "alice", avatarUrl: null },
          },
          {
            id: 11,
            slug: "child-2",
            hidden: true,
            owner: null,
          },
        ],
        nextCursor: undefined,
        hasMore: false,
      });

      const result = await service.getChildrenForAssignment({
        eventTypeId: 100,
        limit: 20,
      });

      // Should filter out item with null owner
      expect(result.children).toHaveLength(1);
      expect(result.children[0]).toEqual({
        childEventTypeId: 10,
        slug: "child-1",
        hidden: false,
        owner: {
          id: 1,
          name: "Alice",
          email: "alice@test.com",
          username: "alice",
          avatarUrl: null,
        },
      });
    });
  });

  describe("searchTeamMembers", () => {
    it("should throw FORBIDDEN if user is not a member of the team when organizations are disabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      const service = createService();
      const membershipRepo = getMembershipRepoInstance();

      vi.mocked(membershipRepo.hasMembership).mockResolvedValue(false);

      await expect(
        service.searchTeamMembers({
          teamId: 1,
          userId: 99,
          limit: 10,
        })
      ).rejects.toThrow(ErrorWithCode);

      await expect(
        service.searchTeamMembers({
          teamId: 1,
          userId: 99,
          limit: 10,
        })
      ).rejects.toMatchObject({ code: "forbidden_error" });
    });

    it("should throw NOT_FOUND if user is not a member of the team when organizations are enabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const service = createService();
      const membershipRepo = getMembershipRepoInstance();

      vi.mocked(membershipRepo.hasMembership).mockResolvedValue(false);

      await expect(service.searchTeamMembers({ teamId: 1, userId: 99, limit: 10 })).rejects.toMatchObject({
        code: "not_found_error",
      });
      expect(membershipRepo.searchMembers).not.toHaveBeenCalled();
    });

    it("should return mapped team members when user is authorized", async () => {
      const service = createService();
      const membershipRepo = getMembershipRepoInstance();

      vi.mocked(membershipRepo.hasMembership).mockResolvedValue(true);
      vi.mocked(membershipRepo.searchMembers).mockResolvedValue({
        memberships: [
          {
            user: {
              id: 5,
              name: "Charlie",
              email: "charlie@test.com",
              avatarUrl: null,
              username: "charlie",
              defaultScheduleId: 1,
            },
            role: MembershipRole.MEMBER,
          },
        ],
        nextCursor: undefined,
        hasMore: false,
      });

      const result = await service.searchTeamMembers({
        teamId: 1,
        userId: 10,
        limit: 20,
      });

      expect(result.members).toHaveLength(1);
      expect(result.members[0]).toEqual({
        userId: 5,
        name: "Charlie",
        email: "charlie@test.com",
        avatarUrl: null,
        username: "charlie",
        defaultScheduleId: 1,
        role: MembershipRole.MEMBER,
      });
    });

    it("should pass search and memberUserIds to repository", async () => {
      const service = createService();
      const membershipRepo = getMembershipRepoInstance();

      vi.mocked(membershipRepo.hasMembership).mockResolvedValue(true);
      vi.mocked(membershipRepo.searchMembers).mockResolvedValue({
        memberships: [],
        nextCursor: undefined,
        hasMore: false,
      });

      await service.searchTeamMembers({
        teamId: 1,
        userId: 10,
        limit: 20,
        search: "test",
        memberUserIds: [1, 2],
      });

      expect(membershipRepo.searchMembers).toHaveBeenCalledWith({
        teamId: 1,
        search: "test",
        cursor: undefined,
        limit: 20,
        memberUserIds: [1, 2],
      });
    });
  });

  describe("assertHostsInTeamOrganization", () => {
    it("should do nothing when organizations are disabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      const { service, teamRepository, userRepository } = createOrgService({ team: buildTeam() });

      await expect(service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1] })).resolves.toBe(
        undefined
      );
      expect(teamRepository.findBasicById).not.toHaveBeenCalled();
      expect(userRepository.findOrganizationIdsByIds).not.toHaveBeenCalled();
    });

    it("should do nothing when there are no host ids", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service, teamRepository, userRepository } = createOrgService({ team: buildTeam() });

      await expect(service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [] })).resolves.toBe(
        undefined
      );
      expect(teamRepository.findBasicById).not.toHaveBeenCalled();
      expect(userRepository.findOrganizationIdsByIds).not.toHaveBeenCalled();
    });

    it("should resolve when the team is not in an organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service, teamRepository, userRepository } = createOrgService({
        team: buildTeam({ parentId: null, isOrganization: false }),
      });

      await expect(service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1] })).resolves.toBe(
        undefined
      );
      expect(teamRepository.findBasicById).toHaveBeenCalledWith({ teamId: 10 });
      expect(userRepository.findOrganizationIdsByIds).not.toHaveBeenCalled();
    });

    it("should resolve when the team is not found", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service, userRepository } = createOrgService({ team: null });

      await expect(service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1] })).resolves.toBe(
        undefined
      );
      expect(userRepository.findOrganizationIdsByIds).not.toHaveBeenCalled();
    });

    it("should use the team's own id as the organization when the team is an organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service, userRepository } = createOrgService({
        team: buildTeam({ id: 50, isOrganization: true, parentId: null }),
        users: [{ id: 1, organizationId: 50 }],
      });

      await expect(service.assertHostsInTeamOrganization({ teamId: 50, hostUserIds: [1] })).resolves.toBe(
        undefined
      );
      expect(userRepository.findOrganizationIdsByIds).toHaveBeenCalledWith({ ids: [1] });
    });

    it("should reject with NOT_FOUND when a host belongs to another organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service } = createOrgService({
        team: buildTeam({ parentId: 100 }),
        users: [
          { id: 1, organizationId: 100 },
          { id: 2, organizationId: 200 },
        ],
      });

      const promise = service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1, 2] });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: "not_found_error" });
      await expect(promise).rejects.toThrow(/users 2 are not in organization 100/);
    });

    it("should reject when a host id is unknown", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service } = createOrgService({
        team: buildTeam({ parentId: 100 }),
        users: [{ id: 1, organizationId: 100 }],
      });

      const promise = service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1, 999] });

      await expect(promise).rejects.toMatchObject({ code: "not_found_error" });
      await expect(promise).rejects.toThrow(/999/);
    });

    it("should resolve when all hosts are in the team's organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service } = createOrgService({
        team: buildTeam({ parentId: 100 }),
        users: [
          { id: 1, organizationId: 100 },
          { id: 2, organizationId: 100 },
        ],
      });

      await expect(service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1, 2] })).resolves.toBe(
        undefined
      );
    });

    it("should dedupe host ids before querying users", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { service, userRepository } = createOrgService({
        team: buildTeam({ parentId: 100 }),
        users: [
          { id: 1, organizationId: 100 },
          { id: 2, organizationId: 100 },
        ],
      });

      await service.assertHostsInTeamOrganization({ teamId: 10, hostUserIds: [1, 2, 1, 2] });

      expect(userRepository.findOrganizationIdsByIds).toHaveBeenCalledWith({ ids: [1, 2] });
    });
  });

  describe("exportHostsForWeights", () => {
    it("should derive teamId from event type instead of trusting input", async () => {
      const service = createService();
      const eventTypeRepo = getEventTypeRepoInstance();
      const hostRepo = getHostRepoInstance();

      vi.mocked(eventTypeRepo.getTeamIdByEventTypeId).mockResolvedValue({ teamId: 42 });
      vi.mocked(hostRepo.findAllRoundRobinHosts).mockResolvedValue([]);

      await service.exportHostsForWeights({
        eventTypeId: 100,
        assignAllTeamMembers: false,
      });

      expect(eventTypeRepo.getTeamIdByEventTypeId).toHaveBeenCalledWith({ id: 100 });
    });

    it("should fetch team members when assignAllTeamMembers is true", async () => {
      const service = createService();
      const eventTypeRepo = getEventTypeRepoInstance();
      const membershipRepo = getMembershipRepoInstance();

      vi.mocked(eventTypeRepo.getTeamIdByEventTypeId).mockResolvedValue({ teamId: 42 });
      vi.mocked(membershipRepo.findAcceptedMembersWithUserProfile).mockResolvedValue([
        {
          user: { id: 1, name: "Alice", email: "alice@test.com", avatarUrl: null },
        },
        {
          user: { id: 2, name: "Bob", email: "bob@test.com", avatarUrl: null },
        },
      ]);

      const result = await service.exportHostsForWeights({
        eventTypeId: 100,
        assignAllTeamMembers: true,
      });

      expect(membershipRepo.findAcceptedMembersWithUserProfile).toHaveBeenCalledWith({ teamId: 42 });
      expect(result.members).toHaveLength(2);
      expect(result.members[0].weight).toBeNull();
      expect(result.members[1].weight).toBeNull();
    });

    it("should fetch round robin hosts when assignAllTeamMembers is false", async () => {
      const service = createService();
      const eventTypeRepo = getEventTypeRepoInstance();
      const hostRepo = getHostRepoInstance();

      vi.mocked(eventTypeRepo.getTeamIdByEventTypeId).mockResolvedValue({ teamId: 42 });
      vi.mocked(hostRepo.findAllRoundRobinHosts).mockResolvedValue([
        {
          userId: 1,
          weight: 150,
          user: { name: "Alice", email: "alice@test.com", avatarUrl: null },
        },
      ]);

      const result = await service.exportHostsForWeights({
        eventTypeId: 100,
        assignAllTeamMembers: false,
      });

      expect(hostRepo.findAllRoundRobinHosts).toHaveBeenCalledWith({ eventTypeId: 100 });
      expect(result.members).toHaveLength(1);
      expect(result.members[0].weight).toBe(150);
    });

    it("should default host weight to 100 when null", async () => {
      const service = createService();
      const eventTypeRepo = getEventTypeRepoInstance();
      const hostRepo = getHostRepoInstance();

      vi.mocked(eventTypeRepo.getTeamIdByEventTypeId).mockResolvedValue({ teamId: 42 });
      vi.mocked(hostRepo.findAllRoundRobinHosts).mockResolvedValue([
        {
          userId: 1,
          weight: null,
          user: { name: "Alice", email: "alice@test.com", avatarUrl: null },
        },
      ]);

      const result = await service.exportHostsForWeights({
        eventTypeId: 100,
        assignAllTeamMembers: false,
      });

      expect(result.members[0].weight).toBe(100);
    });

    it("should return empty members when event type has no teamId and assignAllTeamMembers is false", async () => {
      const service = createService();
      const eventTypeRepo = getEventTypeRepoInstance();
      const hostRepo = getHostRepoInstance();

      vi.mocked(eventTypeRepo.getTeamIdByEventTypeId).mockResolvedValue({ teamId: null });
      vi.mocked(hostRepo.findAllRoundRobinHosts).mockResolvedValue([]);

      const result = await service.exportHostsForWeights({
        eventTypeId: 100,
        assignAllTeamMembers: false,
      });

      expect(result.members).toHaveLength(0);
    });
  });
});
