import { SMSLockState } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    user: { findFirst: vi.fn(), update: vi.fn() },
    team: { findFirst: vi.fn(), update: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import setSMSLockState from "./setSMSLockState.handler";

describe("setSMSLockState", () => {
  const ctx = { user: { id: 1 } as never };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 42 } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({ username: "alice" } as never);
    vi.mocked(prisma.team.findFirst).mockResolvedValue({ id: 9 } as never);
    vi.mocked(prisma.team.update).mockResolvedValue({ slug: "sales" } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("looks up users by username only outside organizations", async () => {
      const result = await setSMSLockState({ ctx, input: { username: "alice", lock: true } });

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: "alice", profiles: { none: {} } },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 42 },
        data: { smsLockState: SMSLockState.LOCKED, smsLockReviewedByAdmin: true },
      });
      expect(result).toEqual({ name: "alice", locked: true });
    });

    it("looks up teams by slug only among top-level teams", async () => {
      const result = await setSMSLockState({ ctx, input: { teamSlug: "sales", lock: false } });

      expect(prisma.team.findFirst).toHaveBeenCalledWith({ where: { slug: "sales", parentId: null } });
      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { smsLockState: SMSLockState.UNLOCKED, smsLockReviewedByAdmin: true },
      });
      expect(result).toEqual({ name: "sales", locked: false });
    });
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    });

    it("finds users by username regardless of their BlueBee profile", async () => {
      await setSMSLockState({ ctx, input: { username: "alice", lock: true } });

      expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { username: "alice" } });
    });

    it("finds teams by slug regardless of their BlueBee parent", async () => {
      await setSMSLockState({ ctx, input: { teamSlug: "sales", lock: true } });

      expect(prisma.team.findFirst).toHaveBeenCalledWith({
        where: { slug: "sales", isOrganization: false },
      });
    });

    it("rejects an unknown team slug", async () => {
      vi.mocked(prisma.team.findFirst).mockResolvedValue(null);

      await expect(setSMSLockState({ ctx, input: { teamSlug: "missing", lock: true } })).rejects.toThrow(
        "Team not found"
      );
    });
  });
});
