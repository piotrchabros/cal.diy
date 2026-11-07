import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole, RedirectType } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import type { ApplyTeamMove, ApplyUserMove } from "./interfaces/IOrganizationMoveRepository";
import { PrismaOrganizationMoveRepository } from "./PrismaOrganizationMoveRepository";

function buildRepository() {
  const user = { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() };
  const team = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  };
  const profile = {
    findMany: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
    deleteMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  };
  const membership = { deleteMany: vi.fn(), upsert: vi.fn() };
  const host = { deleteMany: vi.fn() };
  const verificationToken = { deleteMany: vi.fn() };
  const tempOrgRedirect = { updateMany: vi.fn(), upsert: vi.fn() };
  const client = { user, team, profile, membership, host, verificationToken, tempOrgRedirect };
  const $transaction = vi.fn((fn: (tx: typeof client) => Promise<unknown>, _options: unknown) => fn(client));
  const prismaClient = { ...client, $transaction } as unknown as PrismaClient;
  return {
    repository: new PrismaOrganizationMoveRepository(prismaClient),
    ...client,
    $transaction,
  };
}

function userMove(overrides: Partial<ApplyUserMove> = {}): ApplyUserMove {
  return {
    userId: 7,
    email: "alice@acme.com",
    fromOrganizationId: 1,
    toOrganizationId: 2,
    username: "alice",
    role: "MEMBER",
    keepTeamIds: [],
    redirect: null,
    ...overrides,
  };
}

function teamMove(overrides: Partial<ApplyTeamMove> = {}): ApplyTeamMove {
  return { teamId: 10, toOrganizationId: 2, slug: "sales", removeMembers: [], redirect: null, ...overrides };
}

function redirectUpsert(type: RedirectType, from: string, toUrl: string) {
  return {
    where: { from_type_fromOrgId: { from, type, fromOrgId: 1 } },
    create: { from, type, fromOrgId: 1, toUrl },
    update: { toUrl, enabled: true },
    select: { id: true },
  };
}

describe("PrismaOrganizationMoveRepository", () => {
  it("findUserForMove selects only the fields it needs", async () => {
    const { repository, user } = buildRepository();
    const row = { id: 7, username: "alice", email: "alice@acme.com", organizationId: 1 };
    user.findUnique.mockResolvedValue(row);

    expect(await repository.findUserForMove(7)).toEqual(row);
    expect(user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true, username: true, email: true, organizationId: true },
    });
  });

  it("findTeamForMove flattens members, selects only what it needs and returns null when missing", async () => {
    const { repository, team } = buildRepository();
    const member = { name: "Alice", email: "alice@acme.com", username: "alice", organizationId: null };
    const row = { id: 10, slug: "sales", parentId: 1, isOrganization: false };
    team.findUnique
      .mockResolvedValueOnce({ ...row, members: [{ accepted: false, user: { id: 7, ...member } }] })
      .mockResolvedValueOnce(null);

    expect(await repository.findTeamForMove(10)).toEqual({
      ...row,
      members: [{ userId: 7, ...member, accepted: false }],
    });
    expect(await repository.findTeamForMove(10)).toBeNull();
    const args = team.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ id: 10 });
    expect(args).not.toHaveProperty("include");
    expect(args.select.members).toHaveProperty("select");
  });

  it("isTeamSlugTaken looks for another team with the slug in the organization", async () => {
    const { repository, team } = buildRepository();
    const params = { organizationId: 2, slug: "sales", excludeTeamId: 10 };
    team.findFirst.mockResolvedValueOnce({ id: 11 }).mockResolvedValueOnce(null);

    expect(await repository.isTeamSlugTaken(params)).toBe(true);
    expect(await repository.isTeamSlugTaken(params)).toBe(false);
    expect(team.findFirst).toHaveBeenCalledWith({
      where: { parentId: 2, slug: "sales", id: { not: 10 } },
      select: { id: true },
    });
  });

  describe("findTakenUsernames", () => {
    it("returns the deduplicated union of usernames held by users and profiles", async () => {
      const { repository, user, profile } = buildRepository();
      user.findMany.mockResolvedValue([{ username: "alice" }, { username: null }]);
      profile.findMany.mockResolvedValue([{ username: "alice" }, { username: "bob" }]);

      const result = await repository.findTakenUsernames({
        organizationId: 2,
        usernames: ["alice", "bob", "alice", "carol"],
        excludeUserIds: [7],
      });

      expect(result.sort()).toEqual(["alice", "bob"]);
      const where = { organizationId: 2, username: { in: ["alice", "bob", "carol"] } };
      expect(user.findMany).toHaveBeenCalledWith({
        where: { ...where, id: { notIn: [7] } },
        select: { username: true },
      });
      expect(profile.findMany).toHaveBeenCalledWith({
        where: { ...where, userId: { notIn: [7] } },
        select: { username: true },
      });
    });

    it("returns an empty list without querying when no usernames are given", async () => {
      const { repository, user, profile } = buildRepository();

      const params = { organizationId: 2, usernames: [], excludeUserIds: [] };
      expect(await repository.findTakenUsernames(params)).toEqual([]);
      expect(user.findMany).not.toHaveBeenCalled();
      expect(profile.findMany).not.toHaveBeenCalled();
    });
  });

  describe("applyMove", () => {
    it("runs in an interactive transaction with an extended timeout", async () => {
      const { repository, $transaction } = buildRepository();

      await repository.applyMove({ users: [] });

      expect($transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
    });

    it("moves the team and drops removed members before touching any user", async () => {
      const { repository, team, user, membership, host, verificationToken } = buildRepository();

      await repository.applyMove({
        team: teamMove({ removeMembers: [{ userId: 8, email: "bob@acme.com" }] }),
        users: [userMove({ fromOrganizationId: null })],
      });

      expect(team.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { parentId: 2, slug: "sales" },
        select: { id: true },
      });
      expect(membership.deleteMany).toHaveBeenCalledWith({ where: { teamId: 10, userId: { in: [8] } } });
      expect(host.deleteMany).toHaveBeenCalledWith({
        where: { userId: { in: [8] }, eventType: { teamId: 10 } },
      });
      expect(verificationToken.deleteMany).toHaveBeenCalledWith({
        where: { teamId: 10, identifier: { in: ["bob@acme.com"] } },
      });
      expect(team.update.mock.invocationCallOrder[0]).toBeLessThan(user.update.mock.invocationCallOrder[0]);
    });

    it("disables target team redirects for the slug and upserts both redirect rows", async () => {
      const { repository, membership, tempOrgRedirect } = buildRepository();
      const toUrl = "https://beta.cal.diy/sales";

      await repository.applyMove({
        team: teamMove({ redirect: { fromOrgId: 1, from: "sales", toUrl } }),
        users: [],
      });

      expect(membership.deleteMany).not.toHaveBeenCalled();
      expect(tempOrgRedirect.updateMany).toHaveBeenCalledWith({
        where: {
          fromOrgId: 2,
          from: "sales",
          type: { in: [RedirectType.Team, RedirectType.TeamEventType] },
          enabled: true,
        },
        data: { enabled: false },
      });
      expect(tempOrgRedirect.upsert).toHaveBeenCalledWith(redirectUpsert(RedirectType.Team, "sales", toUrl));
      expect(tempOrgRedirect.upsert).toHaveBeenCalledWith(
        redirectUpsert(RedirectType.TeamEventType, "sales", toUrl)
      );
      expect(tempOrgRedirect.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        tempOrgRedirect.upsert.mock.invocationCallOrder[0]
      );
    });

    it("writes no team redirects when the team has no slug and no redirect", async () => {
      const { repository, tempOrgRedirect } = buildRepository();

      await repository.applyMove({ team: teamMove({ slug: null }), users: [] });

      expect(tempOrgRedirect.updateMany).not.toHaveBeenCalled();
      expect(tempOrgRedirect.upsert).not.toHaveBeenCalled();
    });

    it("leaves the old organization and its teams except the kept ones, moving the profile in place", async () => {
      const { repository, team, membership, host, verificationToken, profile } = buildRepository();
      team.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
      profile.findUnique.mockResolvedValue({ id: 99 });

      await repository.applyMove({ users: [userMove({ keepTeamIds: [10] })] });

      expect(team.findMany).toHaveBeenCalledWith({ where: { parentId: 1 }, select: { id: true } });
      expect(membership.deleteMany).toHaveBeenCalledWith({ where: { userId: 7, teamId: { in: [1, 11] } } });
      expect(host.deleteMany).toHaveBeenCalledWith({
        where: { userId: 7, eventType: { teamId: { in: [1, 11] } } },
      });
      expect(verificationToken.deleteMany).toHaveBeenCalledWith({
        where: { identifier: "alice@acme.com", teamId: { in: [1, 11] } },
      });
      expect(profile.deleteMany).toHaveBeenCalledWith({ where: { userId: 7, organizationId: 2 } });
      expect(profile.findUnique).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: 7, organizationId: 1 } },
        select: { id: true },
      });
      expect(profile.update).toHaveBeenCalledWith({
        where: { id: 99 },
        data: { organizationId: 2, username: "alice" },
        select: { id: true },
      });
      expect(profile.create).not.toHaveBeenCalled();
      expect(profile.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        profile.update.mock.invocationCallOrder[0]
      );
    });

    it("deletes nothing on old teams and creates a profile when the user had no organization", async () => {
      const { repository, team, membership, host, verificationToken, profile, tempOrgRedirect } =
        buildRepository();

      await repository.applyMove({ users: [userMove({ fromOrganizationId: null })] });

      for (const query of [
        team.findMany,
        membership.deleteMany,
        host.deleteMany,
        verificationToken.deleteMany,
      ]) {
        expect(query).not.toHaveBeenCalled();
      }
      expect(profile.findUnique).not.toHaveBeenCalled();
      expect(profile.update).not.toHaveBeenCalled();
      expect(profile.create).toHaveBeenCalledWith({
        data: { uid: expect.any(String), userId: 7, organizationId: 2, username: "alice" },
        select: { id: true },
      });
      expect(tempOrgRedirect.upsert).not.toHaveBeenCalled();
    });

    it("updates the user and upserts the membership without demoting an existing one", async () => {
      const { repository, user, membership } = buildRepository();

      await repository.applyMove({ users: [userMove({ role: "ADMIN" })] });

      expect(user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { organizationId: 2, username: "alice" },
        select: { id: true },
      });
      expect(membership.upsert).toHaveBeenCalledWith({
        where: { userId_teamId: { userId: 7, teamId: 2 } },
        create: { userId: 7, teamId: 2, role: MembershipRole.ADMIN, accepted: true },
        update: { accepted: true },
        select: { id: true },
      });
      expect(user.update.mock.invocationCallOrder[0]).toBeLessThan(
        membership.upsert.mock.invocationCallOrder[0]
      );
    });

    it("promotes an existing membership when moving in as OWNER", async () => {
      const { repository, membership } = buildRepository();

      await repository.applyMove({ users: [userMove({ role: "OWNER" })] });

      expect(membership.upsert.mock.calls[0][0].update).toEqual({
        accepted: true,
        role: MembershipRole.OWNER,
      });
    });

    it("disables target user redirects for the username and upserts the new redirect", async () => {
      const { repository, tempOrgRedirect } = buildRepository();
      const toUrl = "https://beta.cal.diy/alice";

      await repository.applyMove({ users: [userMove({ redirect: { fromOrgId: 1, from: "alice", toUrl } })] });

      expect(tempOrgRedirect.updateMany).toHaveBeenCalledWith({
        where: { fromOrgId: 2, from: "alice", type: { in: [RedirectType.User] }, enabled: true },
        data: { enabled: false },
      });
      expect(tempOrgRedirect.upsert).toHaveBeenCalledTimes(1);
      expect(tempOrgRedirect.upsert).toHaveBeenCalledWith(redirectUpsert(RedirectType.User, "alice", toUrl));
    });

    it("moves a user without a username by dropping old org data and changing only the organization", async () => {
      const { repository, team, user, membership, host, verificationToken, profile, tempOrgRedirect } =
        buildRepository();
      team.findMany.mockResolvedValue([{ id: 11 }]);

      await repository.applyMove({ users: [userMove({ username: null })] });

      expect(membership.deleteMany).toHaveBeenCalledWith({ where: { userId: 7, teamId: { in: [1, 11] } } });
      expect(host.deleteMany).toHaveBeenCalledWith({
        where: { userId: 7, eventType: { teamId: { in: [1, 11] } } },
      });
      expect(verificationToken.deleteMany).toHaveBeenCalledWith({
        where: { identifier: "alice@acme.com", teamId: { in: [1, 11] } },
      });
      expect(profile.deleteMany).toHaveBeenCalledTimes(1);
      expect(profile.deleteMany).toHaveBeenCalledWith({ where: { userId: 7, organizationId: 1 } });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { organizationId: 2 },
        select: { id: true },
      });
      for (const query of [
        profile.findUnique,
        profile.create,
        profile.update,
        membership.upsert,
        tempOrgRedirect.updateMany,
        tempOrgRedirect.upsert,
      ]) {
        expect(query).not.toHaveBeenCalled();
      }
    });

    it("only updates the organization of a user without a username or organization", async () => {
      const { repository, team, user, membership, host, verificationToken, profile, tempOrgRedirect } =
        buildRepository();

      await repository.applyMove({ users: [userMove({ username: null, fromOrganizationId: null })] });

      expect(user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { organizationId: 2 },
        select: { id: true },
      });
      for (const query of [
        team.findMany,
        membership.deleteMany,
        host.deleteMany,
        verificationToken.deleteMany,
        profile.deleteMany,
        profile.findUnique,
        profile.create,
        profile.update,
        membership.upsert,
        tempOrgRedirect.updateMany,
        tempOrgRedirect.upsert,
      ]) {
        expect(query).not.toHaveBeenCalled();
      }
    });

    it("turns a unique constraint violation into a conflict error", async () => {
      const { repository, user } = buildRepository();
      user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "6" })
      );

      const error = await repository.applyMove({ users: [userMove()] }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ErrorWithCode);
      expect(error).toMatchObject({ code: ErrorCode.Conflict, message: "move_conflict" });
    });

    it("rethrows other errors", async () => {
      const { repository, team } = buildRepository();
      const error = new Error("boom");
      team.update.mockRejectedValue(error);

      await expect(repository.applyMove({ team: teamMove(), users: [] })).rejects.toBe(error);
    });
  });
});
