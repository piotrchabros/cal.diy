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
  });
});
