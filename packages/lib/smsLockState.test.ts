import { SMSLockState } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLimit = vi.fn();

vi.mock("./rateLimit", () => ({
  rateLimiter: () => mockLimit,
}));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    team: { findUnique: vi.fn(), update: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import { checkSMSRateLimit } from "./smsLockState";

describe("checkSMSRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue({ success: false });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.team.findUnique).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not change the lock state while under the rate limit", async () => {
    mockLimit.mockResolvedValue({ success: true });
    await checkSMSRateLimit({ identifier: "sms:user:5" });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.team.update).not.toHaveBeenCalled();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("locks only users without an organization profile", async () => {
      await checkSMSRateLimit({ identifier: "sms:user:5" });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 5, profiles: { none: {} } } });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 5, profiles: { none: {} } },
        data: { smsLockState: SMSLockState.LOCKED },
      });
    });

    it("locks only top-level teams", async () => {
      await checkSMSRateLimit({ identifier: "sms:team:7" });

      expect(prisma.team.findUnique).toHaveBeenCalledWith({
        where: { id: 7, parentId: null, isOrganization: false },
      });
      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 7, parentId: null, isOrganization: false },
        data: { smsLockState: SMSLockState.LOCKED },
      });
    });
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    });

    it("locks users regardless of their BlueBee profile", async () => {
      await checkSMSRateLimit({ identifier: "sms:user:5" });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { smsLockState: SMSLockState.LOCKED },
      });
    });

    it("locks teams regardless of their BlueBee parent", async () => {
      await checkSMSRateLimit({ identifier: "sms:team:7", rateLimitingType: "smsMonth" });

      expect(prisma.team.findUnique).toHaveBeenCalledWith({ where: { id: 7, isOrganization: false } });
      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 7, isOrganization: false },
        data: { smsLockState: SMSLockState.REVIEW_NEEDED },
      });
    });

    it("skips users already reviewed by an admin", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ smsLockReviewedByAdmin: true } as never);
      await checkSMSRateLimit({ identifier: "sms:user:5" });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
