import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPersonalEventVisible,
  assertTeamEventVisible,
  hasTeamEventRole,
  teamVisibilitySelect,
} from "./teamEventVisibility";

const nonMemberTeam = { members: [{ userId: 2, accepted: true }], parent: null };

describe("assertTeamEventVisible", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes for a non-member when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    expect(() => assertTeamEventVisible(nonMemberTeam, 1)).not.toThrow();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("passes for an accepted member", () => {
      expect(() =>
        assertTeamEventVisible({ members: [{ userId: 1, accepted: true }], parent: null }, 1)
      ).not.toThrow();
    });

    it("throws NOT_FOUND for a pending member", () => {
      expect(() =>
        assertTeamEventVisible({ members: [{ userId: 1, accepted: false }], parent: null }, 1)
      ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("throws NOT_FOUND for a non-member", () => {
      expect(() => assertTeamEventVisible({ ...nonMemberTeam, parent: { members: [] } }, 1)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });

    it("passes for an admin of the parent organization", () => {
      expect(() =>
        assertTeamEventVisible({ ...nonMemberTeam, parent: { members: [{ userId: 1 }] } }, 1)
      ).not.toThrow();
    });

    it("throws NOT_FOUND for a non-member of a team without a parent", () => {
      expect(() => assertTeamEventVisible(nonMemberTeam, 1)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });
  });
});

describe("teamVisibilitySelect", () => {
  it("selects the caller's accepted admin/owner memberships of the parent organization", () => {
    expect(teamVisibilitySelect(5)).toEqual({
      parent: {
        select: {
          members: {
            where: {
              userId: 5,
              accepted: true,
              role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] },
            },
            select: { userId: true },
          },
        },
      },
    });
  });
});

describe("hasTeamEventRole", () => {
  const allRoles = [MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER];
  const adminRoles = [MembershipRole.ADMIN, MembershipRole.OWNER];
  const teamWith = (accepted: boolean, role: MembershipRole) => ({
    members: [{ userId: 1, accepted, role }],
    parent: null,
  });
  const nonMember = { members: [{ userId: 2, accepted: true, role: MembershipRole.OWNER }] };

  it("allows an accepted member when MEMBER is an allowed role", () => {
    expect(hasTeamEventRole(teamWith(true, MembershipRole.MEMBER), 1, allRoles)).toBe(true);
  });

  it("rejects an accepted member when only admin roles are allowed", () => {
    expect(hasTeamEventRole(teamWith(true, MembershipRole.MEMBER), 1, adminRoles)).toBe(false);
  });

  it("allows an accepted admin", () => {
    expect(hasTeamEventRole(teamWith(true, MembershipRole.ADMIN), 1, adminRoles)).toBe(true);
  });

  it("allows an accepted owner", () => {
    expect(hasTeamEventRole(teamWith(true, MembershipRole.OWNER), 1, adminRoles)).toBe(true);
  });

  it("rejects a pending admin", () => {
    expect(hasTeamEventRole(teamWith(false, MembershipRole.ADMIN), 1, adminRoles)).toBe(false);
  });

  it("rejects a non-member", () => {
    expect(hasTeamEventRole({ ...nonMember, parent: { members: [] } }, 1, allRoles)).toBe(false);
  });

  it("allows an admin of the parent organization who is not a team member when organizations are on", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    expect(hasTeamEventRole({ ...nonMember, parent: { members: [{ userId: 1 }] } }, 1, adminRoles)).toBe(
      true
    );
    vi.unstubAllEnvs();
  });

  it("ignores the BlueBee parent organization while organizations are off", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    expect(hasTeamEventRole({ ...nonMember, parent: { members: [{ userId: 1 }] } }, 1, adminRoles)).toBe(
      false
    );
    vi.unstubAllEnvs();
  });

  it("rejects when the parent organization membership belongs to another user", () => {
    expect(hasTeamEventRole({ ...nonMember, parent: { members: [{ userId: 3 }] } }, 1, adminRoles)).toBe(
      false
    );
  });

  it("rejects a non-member of a team without a parent", () => {
    expect(hasTeamEventRole({ ...nonMember, parent: null }, 1, allRoles)).toBe(false);
  });
});

describe("assertPersonalEventVisible", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes across organizations when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    expect(() => assertPersonalEventVisible({ organizationId: 1 }, 2)).not.toThrow();
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("passes when the owner is in the caller's organization", () => {
      expect(() => assertPersonalEventVisible({ organizationId: 1 }, 1)).not.toThrow();
    });

    it("passes when neither the owner nor the caller is in an organization", () => {
      expect(() => assertPersonalEventVisible({ organizationId: null }, null)).not.toThrow();
    });

    it("throws NOT_FOUND when the owner is in another organization", () => {
      expect(() => assertPersonalEventVisible({ organizationId: 1 }, 2)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });

    it("throws NOT_FOUND when the caller has no organization but the owner does", () => {
      expect(() => assertPersonalEventVisible({ organizationId: 1 }, null)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });

    it("throws NOT_FOUND when the caller has an organization but the owner does not", () => {
      expect(() => assertPersonalEventVisible({ organizationId: null }, 1)).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" })
      );
    });

    it("passes when there is no owner", () => {
      expect(() => assertPersonalEventVisible(null, 1)).not.toThrow();
    });

    it("passes when the owner is undefined", () => {
      expect(() => assertPersonalEventVisible(undefined, 1)).not.toThrow();
    });
  });
});
