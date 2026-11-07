import { beforeEach, describe, expect, it, vi } from "vitest";

const addMember = vi.fn();

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember }),
}));

import { assignPremiumUsername } from "./assignPremiumUsername";

describe("assignPremiumUsername", () => {
  beforeEach(() => {
    addMember.mockReset();
  });

  it("adds the user to the organization as a member with the premium username", async () => {
    addMember.mockResolvedValue({ userId: 1, organizationId: 5, role: "MEMBER" });

    await assignPremiumUsername({ userId: 1, organizationId: 5, username: "premium-user" });

    expect(addMember).toHaveBeenCalledWith({
      organizationId: 5,
      userId: 1,
      role: "MEMBER",
      username: "premium-user",
    });
  });

  it("propagates addMember errors", async () => {
    addMember.mockRejectedValue(new Error("username taken"));

    await expect(
      assignPremiumUsername({ userId: 1, organizationId: 5, username: "premium-user" })
    ).rejects.toThrow("username taken");
  });
});
