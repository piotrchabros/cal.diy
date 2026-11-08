import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import type { PrismaClient } from "@calcom/prisma";
import { readonlyPrisma } from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@calcom/prisma", () => ({
  readonlyPrisma: {
    eventType: {
      findMany: vi.fn(),
    },
    team: {
      findMany: vi.fn(),
    },
    membership: {
      findFirst: vi.fn(),
    },
  },
}));

describe("EventTypeRepository", () => {
  let eventTypeRepository: EventTypeRepository;

  beforeEach(() => {
    vi.resetAllMocks();
    eventTypeRepository = new EventTypeRepository(readonlyPrisma);
  });

  const mockUser = {
    id: 1,
    organizationId: 10,
    isOwnerAdminOfParentTeam: false,
  };

  const mockEventTypes = [
    {
      id: 1,
      slug: "personal-event",
      title: "Personal Event",
      teamId: null,
      userId: 1,
      team: null,
    },
    {
      id: 2,
      slug: "team-event",
      title: "Team Event",
      teamId: 5,
      userId: null,
      team: { name: "Team A" },
    },
  ];

  describe("findFirstIdByTeamSlugAndSlug", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const buildRepository = () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const repository = new EventTypeRepository({ eventType: { findFirst } } as unknown as PrismaClient);
      return { findFirst, repository };
    };

    it("only matches teams outside organizations when organizations are enabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      const { findFirst, repository } = buildRepository();

      const result = await repository.findFirstIdByTeamSlugAndSlug({ teamSlug: "team-a", slug: "intro" });

      expect(result).toBeNull();
      expect(findFirst).toHaveBeenCalledWith({
        where: { slug: "intro", team: { slug: "team-a", parentId: null } },
        select: { id: true },
      });
    });

    it("matches teams by slug alone when organizations are disabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
      const { findFirst, repository } = buildRepository();

      await repository.findFirstIdByTeamSlugAndSlug({ teamSlug: "team-a", slug: "intro" });

      expect(findFirst).toHaveBeenCalledWith({
        where: { slug: "intro", team: { slug: "team-a" } },
        select: { id: true },
      });
    });
  });

  describe("findByIdWithUserIdAndTeamId", () => {
    const buildRepository = (result: { userId: number | null; teamId: number | null } | null) => {
      const findUnique = vi.fn().mockResolvedValue(result);
      const repository = new EventTypeRepository({ eventType: { findUnique } } as unknown as PrismaClient);
      return { findUnique, repository };
    };

    it("selects only userId and teamId for the given id", async () => {
      const { findUnique, repository } = buildRepository({ userId: 7, teamId: 3 });

      const result = await repository.findByIdWithUserIdAndTeamId({ id: 42 });

      expect(result).toEqual({ userId: 7, teamId: 3 });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 42 },
        select: { userId: true, teamId: true },
      });
    });

    it("returns null when the event type does not exist", async () => {
      const { repository } = buildRepository(null);

      const result = await repository.findByIdWithUserIdAndTeamId({ id: 999 });

      expect(result).toBeNull();
    });
  });

  describe("getEventTypeList", () => {
    describe("Early return scenarios", () => {
      it("should return empty array when no teamId, userId, or isAll provided", async () => {
        const result = await eventTypeRepository.getEventTypeList({
          teamId: null,
          userId: null,
          isAll: false,
          user: mockUser,
        });

        expect(result).toEqual([]);
        expect(readonlyPrisma.eventType.findMany).not.toHaveBeenCalled();
      });
    });

    describe("Personal events filtering", () => {
      it("should return only user's personal events when userId provided", async () => {
        const personalEvents = [mockEventTypes[0]];
        vi.mocked(readonlyPrisma.eventType.findMany).mockResolvedValue(personalEvents);

        const result = await eventTypeRepository.getEventTypeList({
          teamId: null,
          userId: 1,
          isAll: false,
          user: mockUser,
        });

        expect(readonlyPrisma.eventType.findMany).toHaveBeenCalledWith({
          select: {
            id: true,
            slug: true,
            title: true,
            teamId: true,
            userId: true,
            team: {
              select: {
                name: true,
              },
            },
          },
          where: {
            userId: mockUser.id,
            teamId: null,
          },
        });
        expect(result).toEqual(personalEvents);
      });
    });

    describe("Organization-wide view (isAll = true)", () => {
      it("should return team events and user's personal events for owner/admin", async () => {
        const childTeams = [{ id: 11 }, { id: 12 }];
        const allEvents = [...mockEventTypes];

        vi.mocked(readonlyPrisma.team.findMany).mockResolvedValue(childTeams);
        vi.mocked(readonlyPrisma.eventType.findMany).mockResolvedValue(allEvents);

        const ownerUser = { ...mockUser, isOwnerAdminOfParentTeam: true };

        const result = await eventTypeRepository.getEventTypeList({
          teamId: null,
          userId: null,
          isAll: true,
          user: ownerUser,
        });

        expect(readonlyPrisma.eventType.findMany).toHaveBeenCalledWith({
          select: {
            id: true,
            slug: true,
            title: true,
            teamId: true,
            userId: true,
            team: {
              select: {
                name: true,
              },
            },
          },
          where: {
            OR: [
              {
                teamId: {
                  in: [10, 11, 12],
                },
              },
              {
                userId: ownerUser.id,
                teamId: null,
              },
            ],
          },
        });
        expect(result).toEqual(allEvents);
      });
    });

    describe("Team-specific view", () => {
      it("should return team events for team members", async () => {
        const membership = { teamId: 5, userId: 1, role: "MEMBER" };
        vi.mocked(readonlyPrisma.membership.findFirst).mockResolvedValue(membership);
        vi.mocked(readonlyPrisma.eventType.findMany).mockResolvedValue([mockEventTypes[1]]);

        const result = await eventTypeRepository.getEventTypeList({
          teamId: 5,
          userId: null,
          isAll: false,
          user: mockUser,
        });

        expect(readonlyPrisma.eventType.findMany).toHaveBeenCalledWith({
          select: {
            id: true,
            slug: true,
            title: true,
            teamId: true,
            userId: true,
            team: {
              select: {
                name: true,
              },
            },
          },
          where: {
            teamId: 5,
            OR: [{ userId: mockUser.id }, { users: { some: { id: mockUser.id } } }],
          },
        });
        expect(result).toEqual([mockEventTypes[1]]);
      });

      it("should throw error when user is not part of team and not owner/admin", async () => {
        vi.mocked(readonlyPrisma.membership.findFirst).mockResolvedValue(null);

        await expect(
          eventTypeRepository.getEventTypeList({
            teamId: 5,
            userId: null,
            isAll: false,
            user: mockUser,
          })
        ).rejects.toThrow("User is not part of a team/org");
      });
    });
  });

  // TODO: Add tests for other EventTypeRepository methods as they are added
  // Examples:
  // - describe("findById", () => { ... })
  // - describe("create", () => { ... })
  // - describe("findAllByUpId", () => { ... })
  // etc.
});
