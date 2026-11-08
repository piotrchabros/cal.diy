import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import {
  buildTeamPermissionsMap,
  getEffectiveRole,
  getTeamPermissions,
  hasHigherPrivilege,
} from "./permissionUtils";

describe("hasHigherPrivilege", () => {
  it("orders OWNER above ADMIN above MEMBER", () => {
    expect(hasHigherPrivilege(MembershipRole.OWNER, MembershipRole.ADMIN)).toBe(true);
    expect(hasHigherPrivilege(MembershipRole.ADMIN, MembershipRole.MEMBER)).toBe(true);
    expect(hasHigherPrivilege(MembershipRole.MEMBER, MembershipRole.MEMBER)).toBe(false);
    expect(hasHigherPrivilege(MembershipRole.MEMBER, MembershipRole.OWNER)).toBe(false);
  });
});

describe("getEffectiveRole", () => {
  it("keeps the team role when there is no organization membership", () => {
    expect(getEffectiveRole(undefined, MembershipRole.MEMBER)).toBe(MembershipRole.MEMBER);
  });

  it("elevates to the organization role when it is higher", () => {
    expect(getEffectiveRole(MembershipRole.ADMIN, MembershipRole.MEMBER)).toBe(MembershipRole.ADMIN);
  });

  it("keeps the team role when it is higher than the organization role", () => {
    expect(getEffectiveRole(MembershipRole.MEMBER, MembershipRole.OWNER)).toBe(MembershipRole.OWNER);
  });
});

describe("getTeamPermissions", () => {
  it("grants every permission to accepted admins and owners", () => {
    for (const role of [MembershipRole.ADMIN, MembershipRole.OWNER]) {
      expect(getTeamPermissions(role)).toEqual({
        canCreate: true,
        canEdit: true,
        canDelete: true,
        canRead: true,
      });
    }
  });

  it("grants read-only permission to accepted members", () => {
    expect(getTeamPermissions(MembershipRole.MEMBER)).toEqual({
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canRead: true,
    });
  });
});

describe("buildTeamPermissionsMap", () => {
  it("grants every permission to team admins and owners", () => {
    const map = buildTeamPermissionsMap(
      [
        { team: { id: 1, parentId: null }, role: MembershipRole.ADMIN },
        { team: { id: 2, parentId: null }, role: MembershipRole.OWNER },
      ],
      []
    );

    expect(map.get(1)).toEqual({ canCreate: true, canEdit: true, canDelete: true, canRead: true });
    expect(map.get(2)).toEqual({ canCreate: true, canEdit: true, canDelete: true, canRead: true });
  });

  it("grants read-only permission to plain team members", () => {
    const map = buildTeamPermissionsMap(
      [{ team: { id: 1, parentId: 9 }, role: MembershipRole.MEMBER }],
      [{ teamId: 9, membershipRole: MembershipRole.MEMBER }]
    );

    expect(map.get(1)).toEqual({ canCreate: false, canEdit: false, canDelete: false, canRead: true });
  });

  it("elevates a team member through an accepted parent-organization admin membership", () => {
    const map = buildTeamPermissionsMap(
      [{ team: { id: 1, parentId: 9 }, role: MembershipRole.MEMBER }],
      [{ teamId: 9, membershipRole: MembershipRole.ADMIN }]
    );

    expect(map.get(1)).toEqual({ canCreate: true, canEdit: true, canDelete: true, canRead: true });
  });

  it("does not elevate a team member through an unrelated organization membership", () => {
    const map = buildTeamPermissionsMap(
      [{ team: { id: 1, parentId: 9 }, role: MembershipRole.MEMBER }],
      [{ teamId: 10, membershipRole: MembershipRole.OWNER }]
    );

    expect(map.get(1)).toEqual({ canCreate: false, canEdit: false, canDelete: false, canRead: true });
  });

  it("omits teams the caller has no membership of", () => {
    const map = buildTeamPermissionsMap(
      [{ team: { id: 1, parentId: null }, role: MembershipRole.ADMIN }],
      []
    );

    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);
  });
});
