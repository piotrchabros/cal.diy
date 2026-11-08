import type { PrismaClient } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

describe("MembershipRepository.findTeamIdsByAcceptedRole", () => {
  const roleFilter = (roles: MembershipRole[]) => ({
    members: { some: { userId: 5, accepted: true, role: { in: roles } } },
  });

  it("matches only accepted team roles or accepted parent organization roles for one team", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 9 }]);
    const repo = new MembershipRepository({ team: { findMany } } as unknown as PrismaClient);

    const result = await repo.findTeamIdsByAcceptedRole({
      userId: 5,
      teamId: 9,
      teamRoles: [MembershipRole.MEMBER],
      parentRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
    });

    expect(result).toEqual([9]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: 9,
        OR: [
          roleFilter([MembershipRole.MEMBER]),
          { parent: roleFilter([MembershipRole.ADMIN, MembershipRole.OWNER]) },
        ],
      },
      select: { id: true },
    });
  });

  it("lists every matching team when no teamId is given", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const repo = new MembershipRepository({ team: { findMany } } as unknown as PrismaClient);

    const result = await repo.findTeamIdsByAcceptedRole({
      userId: 5,
      teamRoles: [MembershipRole.ADMIN],
      parentRoles: [MembershipRole.OWNER],
    });

    expect(result).toEqual([1, 2]);
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("id");
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("isOrganization");
  });

  it("leaves organizations out when asked", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new MembershipRepository({ team: { findMany } } as unknown as PrismaClient);

    await repo.findTeamIdsByAcceptedRole({
      userId: 5,
      teamRoles: [MembershipRole.ADMIN],
      parentRoles: [],
      includeOrganizations: false,
    });

    expect(findMany.mock.calls[0][0].where.isOrganization).toBe(false);
  });
});

describe("MembershipRepository.findRoleAndAcceptedByUserIdAndTeamId", () => {
  it("selects only the role and whether the membership was accepted", async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: MembershipRole.ADMIN, accepted: false });
    const repo = new MembershipRepository({ membership: { findUnique } } as unknown as PrismaClient);

    const result = await repo.findRoleAndAcceptedByUserIdAndTeamId({ userId: 5, teamId: 9 });

    expect(result).toEqual({ role: MembershipRole.ADMIN, accepted: false });
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_teamId: { userId: 5, teamId: 9 } },
      select: { role: true, accepted: true },
    });
  });
});

describe("MembershipRepository.findAcceptedAdminOrOwnerByUserIdAndTeamId", () => {
  it("finds an accepted admin or owner membership and selects only its id", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 3 });
    const repo = new MembershipRepository({ membership: { findFirst } } as unknown as PrismaClient);

    const result = await repo.findAcceptedAdminOrOwnerByUserIdAndTeamId({ userId: 5, teamId: 9 });

    expect(result).toEqual({ id: 3 });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 5,
        teamId: 9,
        accepted: true,
        role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] },
      },
      select: { id: true },
    });
  });

  it("returns null when the user is not an accepted admin or owner", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = new MembershipRepository({ membership: { findFirst } } as unknown as PrismaClient);

    const result = await repo.findAcceptedAdminOrOwnerByUserIdAndTeamId({ userId: 5, teamId: 9 });

    expect(result).toBeNull();
  });
});
