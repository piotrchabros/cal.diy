import type { PrismaClient } from "@calcom/prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

describe("MembershipRepository.findAcceptedPublicMembersByTeamId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("queries only accepted, listable members, matching nobody outside an organization, and selects no email", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new MembershipRepository({ membership: { findMany } } as unknown as PrismaClient);

    await repo.findAcceptedPublicMembersByTeamId({ teamId: 10 });

    expect(findMany).toHaveBeenCalledOnce();
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      teamId: 10,
      accepted: true,
      user: { username: { not: null }, locked: false, isPlatformManaged: false, id: { in: [] } },
    });
    expect(args.select).toEqual({
      user: { select: { id: true, username: true, name: true, avatarUrl: true } },
    });
    expect(args.select.user.select).not.toHaveProperty("email");
    expect(args.orderBy).toEqual({ user: { id: "asc" } });
  });

  it("does not filter out organization members when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new MembershipRepository({ membership: { findMany } } as unknown as PrismaClient);

    await repo.findAcceptedPublicMembersByTeamId({ teamId: 10 });

    const args = findMany.mock.calls[0][0];
    expect(args.where.user).toEqual({ username: { not: null }, locked: false, isPlatformManaged: false });
    expect(args.where.user).not.toHaveProperty("id");
  });
});
