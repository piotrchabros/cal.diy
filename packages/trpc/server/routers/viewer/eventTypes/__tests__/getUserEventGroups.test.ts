import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserEventGroups } from "../getUserEventGroups.handler";

// Mock dependencies
vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: vi.fn(),
}));

const { mockFindAllByUpIdIncludeTeam, mockFindTeamIdsByAcceptedRole, MockMembershipRepository } = vi.hoisted(
  () => {
    const mockFindAllByUpIdIncludeTeam = vi.fn();
    const mockFindUniqueByUserIdAndTeamId = vi.fn();
    const mockFindTeamIdsByAcceptedRole = vi.fn().mockResolvedValue([]);

    class MockMembershipRepository {
      static findAllByUpIdIncludeTeam = mockFindAllByUpIdIncludeTeam;
      findUniqueByUserIdAndTeamId = mockFindUniqueByUserIdAndTeamId;
      findTeamIdsByAcceptedRole = mockFindTeamIdsByAcceptedRole;
    }

    return { mockFindAllByUpIdIncludeTeam, mockFindTeamIdsByAcceptedRole, MockMembershipRepository };
  }
);

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: MockMembershipRepository,
}));

vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: {
    findByUpIdWithAuth: vi.fn(),
  },
}));

const mockFilterTeamsByEventTypeReadPermission = vi.fn();

vi.mock("../teamAccessUseCase", () => ({
  TeamAccessUseCase: vi.fn().mockImplementation(function () {
    return {
      filterTeamsByEventTypeReadPermission: mockFilterTeamsByEventTypeReadPermission,
    };
  }),
}));

vi.mock("@calcom/lib/getAvatarUrl", () => ({
  getUserAvatarUrl: vi.fn().mockReturnValue("https://avatar.com/user.jpg"),
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({
    getBaseUrl: async ({ organizationId }: { organizationId: number | null }) =>
      organizationId ? `https://org${organizationId}.example` : "https://app.example",
  }),
}));

vi.mock("@calcom/lib/defaultAvatarImage", () => ({
  getPlaceholderAvatar: vi.fn().mockReturnValue("https://avatar.com/placeholder.jpg"),
}));

describe("getUserEventGroups", () => {
  const mockUser = {
    id: 1,
    profile: {
      upId: "user-123",
    },
  } as unknown as NonNullable<Parameters<typeof getUserEventGroups>[0]["ctx"]["user"]>;

  const mockProfile = {
    id: 1,
    username: "testuser",
    name: "Test User",
    avatarUrl: null,
    organizationId: null,
    organization: null,
  } as unknown as NonNullable<
    Awaited<
      ReturnType<
        typeof import("@calcom/features/profile/repositories/ProfileRepository").ProfileRepository.findByUpIdWithAuth
      >
    >
  >;

  const mockCtx = {
    user: mockUser,
    prisma: {} as PrismaClient,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTeamIdsByAcceptedRole.mockResolvedValue([]);
  });

  describe("Basic functionality", () => {
    it("should throw TRPCError when profile is not found", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");
      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(null);

      await expect(
        getUserEventGroups({
          ctx: mockCtx,
          input: null,
        })
      ).rejects.toThrow(TRPCError);
    });

    it("should return user event groups when no filters are applied", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");

      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfile);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([]);

      const result = await getUserEventGroups({
        ctx: mockCtx,
        input: null,
      });

      expect(result).toHaveProperty("eventTypeGroups");
      expect(result).toHaveProperty("profiles");
      expect(result.eventTypeGroups).toHaveLength(1);
      expect(result.eventTypeGroups[0]).toMatchObject({
        teamId: null,
        membershipRole: null,
        profile: {
          slug: "testuser",
          name: "Test User",
        },
      });
    });
  });

  describe("Team memberships", () => {
    it("should include team events when team memberships exist", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");

      const mockTeamMembership = {
        id: 1,
        teamId: 100,
        userId: 1,
        accepted: true,
        role: MembershipRole.MEMBER,
        customRoleId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        team: {
          id: 100,
          name: "Test Team",
          slug: "test-team",
          logoUrl: null,
          parentId: null,
          parent: null,
          metadata: {},
        },
      } as unknown as NonNullable<
        Awaited<
          ReturnType<
            typeof import("@calcom/features/membership/repositories/MembershipRepository").MembershipRepository.findAllByUpIdIncludeTeam
          >
        >
      >[0];

      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfile);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([mockTeamMembership]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([mockTeamMembership]);

      const result = await getUserEventGroups({
        ctx: mockCtx,
        input: null,
      });

      expect(result.eventTypeGroups).toHaveLength(2); // User + Team
      expect(result.eventTypeGroups[1]).toMatchObject({
        teamId: 100,
        profile: {
          name: "Test Team",
          slug: "team/test-team",
        },
      });
    });
  });

  describe("Permissions", () => {
    const teamMembership = (teamId: number, role: MembershipRole) =>
      ({
        id: teamId,
        teamId,
        userId: 1,
        accepted: true,
        role,
        customRoleId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        team: {
          id: teamId,
          name: `Team ${teamId}`,
          slug: `team-${teamId}`,
          logoUrl: null,
          parentId: null,
          parent: null,
          metadata: {},
        },
      }) as unknown as NonNullable<
        Awaited<
          ReturnType<
            typeof import("@calcom/features/membership/repositories/MembershipRepository").MembershipRepository.findAllByUpIdIncludeTeam
          >
        >
      >[0];

    it("lets only accepted team admins/owners create team event types", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");
      const adminTeam = teamMembership(100, MembershipRole.ADMIN);
      const memberTeam = teamMembership(200, MembershipRole.MEMBER);

      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfile);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([adminTeam, memberTeam]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([adminTeam, memberTeam]);
      mockFindTeamIdsByAcceptedRole.mockResolvedValue([100]);

      const result = await getUserEventGroups({
        ctx: mockCtx,
        input: null,
      });

      expect(result.teamPermissions[100]).toEqual({ canCreateEventType: true });
      expect(result.teamPermissions[200]).toEqual({ canCreateEventType: false });
      expect(mockFindTeamIdsByAcceptedRole).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, teamRoles: [MembershipRole.OWNER, MembershipRole.ADMIN] })
      );
    });
    it("lets a system admin create event types in every listed team, matching heavy/create.handler", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");
      const adminTeam = teamMembership(100, MembershipRole.ADMIN);
      const memberTeam = teamMembership(200, MembershipRole.MEMBER);

      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfile);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([adminTeam, memberTeam]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([adminTeam, memberTeam]);
      mockFindTeamIdsByAcceptedRole.mockResolvedValue([100]);

      const result = await getUserEventGroups({
        ctx: { ...mockCtx, user: { ...mockCtx.user, role: "ADMIN" } as typeof mockCtx.user },
        input: null,
      });

      expect(result.teamPermissions[100]).toEqual({ canCreateEventType: true });
      expect(result.teamPermissions[200]).toEqual({ canCreateEventType: true });
    });

    it("does not treat a non-ADMIN system role as a bypass", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");
      const memberTeam = teamMembership(200, MembershipRole.MEMBER);

      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfile);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([memberTeam]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([memberTeam]);
      mockFindTeamIdsByAcceptedRole.mockResolvedValue([]);

      const result = await getUserEventGroups({
        ctx: { ...mockCtx, user: { ...mockCtx.user, role: "USER" } as typeof mockCtx.user },
        input: null,
      });

      expect(result.teamPermissions[200]).toEqual({ canCreateEventType: false });
    });
  });

  describe("Organization handling", () => {
    it("should handle organization locked event types", async () => {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");

      const mockProfileWithOrg = {
        ...mockProfile,
        organization: {
          organizationSettings: {
            lockEventTypeCreationForUsers: true,
          },
        },
      } as unknown as NonNullable<
        Awaited<
          ReturnType<
            typeof import("@calcom/features/profile/repositories/ProfileRepository").ProfileRepository.findByUpIdWithAuth
          >
        >
      >;

      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfileWithOrg);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([]);

      const result = await getUserEventGroups({
        ctx: mockCtx,
        input: null,
      });

      expect(result.eventTypeGroups[0].profile.eventTypesLockedByOrg).toBe(true);
    });
  });
  describe("Teams under the organization", () => {
    const teamUnderOrg = {
      id: 1,
      teamId: 100,
      userId: 1,
      accepted: true,
      role: MembershipRole.MEMBER,
      team: {
        id: 100,
        name: "Test Team",
        slug: "test-team",
        logoUrl: null,
        parentId: 1,
        parent: { name: "BlueBee", slug: "bluebee", logoUrl: "bluebee.png", metadata: {} },
        metadata: {},
      },
    };
    const orgOwnership = {
      id: 2,
      teamId: 1,
      userId: 1,
      accepted: true,
      role: MembershipRole.OWNER,
      team: {
        id: 1,
        name: "BlueBee",
        slug: "bluebee",
        logoUrl: null,
        parentId: null,
        parent: null,
        metadata: {},
      },
    };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function getTeamGroup() {
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");
      const { getPlaceholderAvatar } = await import("@calcom/lib/defaultAvatarImage");
      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue(mockProfile);
      mockFindAllByUpIdIncludeTeam.mockResolvedValue([teamUnderOrg, orgOwnership]);
      mockFilterTeamsByEventTypeReadPermission.mockResolvedValue([teamUnderOrg]);

      const result = await getUserEventGroups({ ctx: mockCtx, input: null });

      return { group: result.eventTypeGroups[1], avatarArgs: vi.mocked(getPlaceholderAvatar).mock.calls };
    }

    it("treats the team as top-level when organizations are disabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");

      const { group, avatarArgs } = await getTeamGroup();

      expect(group).toMatchObject({
        teamId: 100,
        parentId: null,
        membershipRole: MembershipRole.MEMBER,
        profile: { slug: "team/test-team" },
      });
      expect(avatarArgs).toEqual([[null, "Test Team"]]);
    });

    it("uses the organization parent and role when organizations are enabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

      const { group, avatarArgs } = await getTeamGroup();

      expect(group).toMatchObject({
        teamId: 100,
        parentId: 1,
        membershipRole: MembershipRole.OWNER,
        profile: { slug: "test-team" },
      });
      expect(avatarArgs).toEqual([["bluebee.png", "BlueBee"]]);
    });
  });
});
