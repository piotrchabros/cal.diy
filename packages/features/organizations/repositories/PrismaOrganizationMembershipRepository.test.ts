import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaOrganizationMembershipRepository } from "./PrismaOrganizationMembershipRepository";

function buildRepository() {
  const user = { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() };
  const profile = { findFirst: vi.fn(), upsert: vi.fn() };
  const membership = { findUnique: vi.fn(), upsert: vi.fn(), count: vi.fn(), update: vi.fn() };
  const $transaction = vi.fn((operations: Promise<unknown>[]) => Promise.all(operations));
  const prismaClient = { user, profile, membership, $transaction } as unknown as PrismaClient;
  return {
    repository: new PrismaOrganizationMembershipRepository(prismaClient),
    user,
    profile,
    membership,
    $transaction,
  };
}

describe("PrismaOrganizationMembershipRepository", () => {
  it("findUserById selects only the fields it needs", async () => {
    const { repository, user } = buildRepository();
    const row = { id: 7, username: "alice", email: "alice@acme.com", organizationId: null };
    user.findUnique.mockResolvedValue(row);

    const result = await repository.findUserById(7);

    expect(user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true, username: true, email: true, organizationId: true },
    });
    expect(user.findUnique.mock.calls[0][0]).not.toHaveProperty("include");
    expect(result).toEqual(row);
  });

  describe("findUserByEmail", () => {
    it("matches the email case-insensitively and selects only the fields it needs", async () => {
      const { repository, user } = buildRepository();
      const row = { id: 7, username: "alice", email: "alice@acme.com", organizationId: 2 };
      user.findFirst.mockResolvedValue(row);

      const result = await repository.findUserByEmail("Alice@Acme.com");

      expect(user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: "Alice@Acme.com", mode: "insensitive" } },
        select: { id: true, username: true, email: true, organizationId: true },
      });
      expect(user.findFirst.mock.calls[0][0]).not.toHaveProperty("include");
      expect(result).toEqual(row);
    });

    it("returns null when no user has the email", async () => {
      const { repository, user } = buildRepository();
      user.findFirst.mockResolvedValue(null);

      expect(await repository.findUserByEmail("nobody@acme.com")).toBeNull();
    });
  });

  describe("isUsernameTaken", () => {
    it("checks users and profiles in the organization, excluding the user", async () => {
      const { repository, user, profile } = buildRepository();
      user.findFirst.mockResolvedValue(null);
      profile.findFirst.mockResolvedValue(null);

      const result = await repository.isUsernameTaken({
        organizationId: 1,
        username: "alice",
        excludeUserId: 7,
      });

      expect(result).toBe(false);
      expect(user.findFirst).toHaveBeenCalledWith({
        where: { username: "alice", organizationId: 1, id: { not: 7 } },
        select: { id: true },
      });
      expect(profile.findFirst).toHaveBeenCalledWith({
        where: { username: "alice", organizationId: 1, userId: { not: 7 } },
        select: { id: true },
      });
    });

    it("returns true when a user holds the username", async () => {
      const { repository, user, profile } = buildRepository();
      user.findFirst.mockResolvedValue({ id: 8 });
      profile.findFirst.mockResolvedValue(null);

      expect(
        await repository.isUsernameTaken({ organizationId: 1, username: "alice", excludeUserId: 7 })
      ).toBe(true);
    });

    it("returns true when a profile holds the username", async () => {
      const { repository, user, profile } = buildRepository();
      user.findFirst.mockResolvedValue(null);
      profile.findFirst.mockResolvedValue({ id: 3 });

      expect(
        await repository.isUsernameTaken({ organizationId: 1, username: "alice", excludeUserId: 7 })
      ).toBe(true);
    });
  });

  describe("addMember", () => {
    it("links the user, upserts the profile and membership in one transaction", async () => {
      const { repository, user, profile, membership, $transaction } = buildRepository();
      user.update.mockResolvedValue({ id: 7 });
      profile.upsert.mockResolvedValue({ id: 3 });
      membership.upsert.mockResolvedValue({ role: "OWNER" });

      const result = await repository.addMember({
        organizationId: 1,
        userId: 7,
        username: "alice",
        role: "MEMBER",
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      expect($transaction.mock.calls[0][0]).toHaveLength(3);

      expect(user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { organizationId: 1 },
        select: { id: true },
      });

      const profileArgs = profile.upsert.mock.calls[0][0];
      expect(profileArgs.where).toEqual({ userId_organizationId: { userId: 7, organizationId: 1 } });
      expect(profileArgs.create).toEqual({
        uid: expect.any(String),
        userId: 7,
        organizationId: 1,
        username: "alice",
      });
      expect(profileArgs.create.uid.length).toBeGreaterThan(0);
      expect(profileArgs.update).toEqual({ username: "alice" });
      expect(profileArgs.select).toEqual({ id: true });

      const membershipArgs = membership.upsert.mock.calls[0][0];
      expect(membershipArgs.where).toEqual({ userId_teamId: { userId: 7, teamId: 1 } });
      expect(membershipArgs.create).toEqual({ userId: 7, teamId: 1, role: "MEMBER", accepted: true });
      expect(membershipArgs.update).toEqual({ accepted: true });
      expect(membershipArgs.update).not.toHaveProperty("role");
      expect(membershipArgs.select).toEqual({ role: true });

      for (const args of [user.update, profile.upsert, membership.upsert].map((fn) => fn.mock.calls[0][0])) {
        expect(args).not.toHaveProperty("include");
      }

      expect(result).toEqual({ userId: 7, organizationId: 1, role: "OWNER" });
    });
  });

  describe("findRole", () => {
    it("returns the role of an accepted membership", async () => {
      const { repository, membership } = buildRepository();
      membership.findUnique.mockResolvedValue({ role: "ADMIN", accepted: true });

      const result = await repository.findRole({ organizationId: 1, userId: 7 });

      expect(membership.findUnique).toHaveBeenCalledWith({
        where: { userId_teamId: { userId: 7, teamId: 1 } },
        select: { role: true, accepted: true },
      });
      expect(result).toBe("ADMIN");
    });

    it("returns null for a non-accepted membership", async () => {
      const { repository, membership } = buildRepository();
      membership.findUnique.mockResolvedValue({ role: "OWNER", accepted: false });

      expect(await repository.findRole({ organizationId: 1, userId: 7 })).toBeNull();
    });

    it("returns null when there is no membership", async () => {
      const { repository, membership } = buildRepository();
      membership.findUnique.mockResolvedValue(null);

      expect(await repository.findRole({ organizationId: 1, userId: 7 })).toBeNull();
    });
  });

  it("countOwners counts accepted owners of the organization", async () => {
    const { repository, membership } = buildRepository();
    membership.count.mockResolvedValue(2);

    const result = await repository.countOwners(1);

    expect(membership.count).toHaveBeenCalledWith({ where: { teamId: 1, role: "OWNER", accepted: true } });
    expect(result).toBe(2);
  });

  it("updateRole updates the membership role", async () => {
    const { repository, membership } = buildRepository();
    membership.update.mockResolvedValue({ userId: 7, role: "ADMIN" });

    const result = await repository.updateRole({ organizationId: 1, userId: 7, role: "ADMIN" });

    expect(membership.update).toHaveBeenCalledWith({
      where: { userId_teamId: { userId: 7, teamId: 1 } },
      data: { role: "ADMIN" },
      select: { userId: true, role: true },
    });
    expect(membership.update.mock.calls[0][0]).not.toHaveProperty("include");
    expect(result).toEqual({ userId: 7, role: "ADMIN" });
  });
});
