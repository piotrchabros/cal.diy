import { PrismaClient } from "@calcom/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostRepository } from "./HostRepository";

vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    host: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
  };
  return {
    __esModule: true,
    default: mockPrisma,
    PrismaClient: vi.fn().mockImplementation(function () {
      return mockPrisma;
    }),
  };
});

describe("HostRepository", () => {
  let prisma: PrismaClient;
  let hostRepo: HostRepository;

  beforeEach(() => {
    prisma = new PrismaClient();
    hostRepo = new HostRepository(prisma);
    vi.clearAllMocks();
  });

  describe("updateHostsWithNewDefaultSchedule", () => {
    it("should update hosts with new scheduleId", async () => {
      const userId = 1;
      const oldScheduleId = 123;
      const newScheduleId = 456;
      const updateResult = { count: 2 }; // 2 hosts updated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma.host.updateMany as any).mockResolvedValue(updateResult);

      const result = await hostRepo.updateHostsSchedule(userId, oldScheduleId, newScheduleId);

      expect(prisma.host.updateMany).toHaveBeenCalledWith({
        where: {
          userId,
          scheduleId: oldScheduleId,
        },
        data: {
          scheduleId: newScheduleId,
        },
      });
      expect(result).toEqual(updateResult);
    });

    it("should handle case with no hosts to update", async () => {
      const userId = 1;
      const oldScheduleId = 123;
      const newScheduleId = 456;
      const updateResult = { count: 0 }; // No hosts updated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma.host.updateMany as any).mockResolvedValue(updateResult);

      const result = await hostRepo.updateHostsSchedule(userId, oldScheduleId, newScheduleId);

      expect(prisma.host.updateMany).toHaveBeenCalledWith({
        where: {
          userId,
          scheduleId: oldScheduleId,
        },
        data: {
          scheduleId: newScheduleId,
        },
      });
      expect(result).toEqual(updateResult);
    });
  });

  describe("findByEventTypeIdIncludeUser", () => {
    it("selects only public user fields, ordered by priority then creation", async () => {
      const rows = [{ user: { id: 1, name: "A", username: "a", avatarUrl: null } }];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma.host.findMany as any).mockResolvedValue(rows);

      const result = await hostRepo.findByEventTypeIdIncludeUser({ eventTypeId: 9 });

      expect(result).toEqual(rows);
      expect(prisma.host.findMany).toHaveBeenCalledWith({
        where: { eventTypeId: 9 },
        select: { user: { select: { id: true, name: true, username: true, avatarUrl: true } } },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
    });
  });
});
