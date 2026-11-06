import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { addMember, upsertAcceptedTeamMembership, tx, transaction } = vi.hoisted(() => {
  const tx = {
    user: { findUnique: vi.fn() },
    profile: { upsert: vi.fn() },
    membership: { upsert: vi.fn() },
  };
  return {
    addMember: vi.fn(),
    upsertAcceptedTeamMembership: vi.fn(),
    tx,
    transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
});

vi.mock("@calcom/prisma", () => ({
  prisma: { $transaction: transaction },
  default: { $transaction: transaction },
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember }),
}));

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    upsertAcceptedTeamMembership = upsertAcceptedTeamMembership;
  },
}));

import { createOrUpdateMemberships } from "./createOrUpdateMemberships";

const user = { id: 7 };
const orgTeam = { id: 100, parentId: null, isOrganization: true, organizationSettings: null, parent: null };
const subTeam = {
  id: 200,
  parentId: 100,
  isOrganization: false,
  parent: { id: 100, organizationSettings: null },
};
const plainTeam = { id: 300, parentId: null, isOrganization: false, parent: null };

describe("createOrUpdateMemberships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.user.findUnique.mockResolvedValue({ username: "alice", email: "alice@acme.com" });
    tx.membership.upsert.mockResolvedValue({ id: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("adds the user to the organization without a separate team membership when the team is the org", async () => {
      await createOrUpdateMemberships({ user, team: orgTeam });

      expect(addMember).toHaveBeenCalledWith({ organizationId: 100, userId: 7, role: "MEMBER" });
      expect(upsertAcceptedTeamMembership).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("adds the user to the parent organization and upserts the sub-team membership", async () => {
      await createOrUpdateMemberships({ user, team: subTeam });

      expect(addMember).toHaveBeenCalledWith({ organizationId: 100, userId: 7, role: "MEMBER" });
      expect(upsertAcceptedTeamMembership).toHaveBeenCalledWith({ teamId: 200, userId: 7 });
      expect(transaction).not.toHaveBeenCalled();
    });

    it("falls back to the legacy transaction for a team outside any organization", async () => {
      await createOrUpdateMemberships({ user, team: plainTeam });

      expect(addMember).not.toHaveBeenCalled();
      expect(upsertAcceptedTeamMembership).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(tx.profile.upsert).not.toHaveBeenCalled();
      expect(tx.membership.upsert).toHaveBeenCalledTimes(1);
      expect(tx.membership.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId_teamId: { userId: 7, teamId: 300 } } })
      );
    });
  });

  describe("with organizations disabled", () => {
    it("uses the legacy transaction for an organization team", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");

      await createOrUpdateMemberships({ user, team: orgTeam });

      expect(addMember).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(tx.profile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_organizationId: { userId: 7, organizationId: 100 } },
          update: { username: "alice" },
        })
      );
      expect(tx.membership.upsert).toHaveBeenCalledTimes(1);
      expect(tx.membership.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_teamId: { userId: 7, teamId: 100 } },
          update: { accepted: true },
        })
      );
    });
  });
});
