import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertTeamEventVisible, teamVisibilitySelect } from "./teamEventVisibility";

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
