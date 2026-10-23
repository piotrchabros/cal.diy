import type { PrismaClient } from "@calcom/prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

describe("MembershipRepository.findAcceptedPublicMembersByTeamId", () => {
  it("queries only accepted, listable members and selects no email", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new MembershipRepository({ membership: { findMany } } as unknown as PrismaClient);

    await repo.findAcceptedPublicMembersByTeamId({ teamId: 10 });

    expect(findMany).toHaveBeenCalledOnce();
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      teamId: 10,
      accepted: true,
      user: { username: { not: null }, locked: false, isPlatformManaged: false, organizationId: null },
    });
    expect(args.select).toEqual({
      user: { select: { id: true, username: true, name: true, avatarUrl: true } },
    });
    expect(args.select.user.select).not.toHaveProperty("email");
    expect(args.orderBy).toEqual({ user: { id: "asc" } });
  });
});
