import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaOrganizationRepository } from "./PrismaOrganizationRepository";

type OrganizationRow = {
  id: number;
  name: string;
  slug: string | null;
  organizationSettings: { customDomain: string | null } | null;
  _count: { orgUsers: number; children: number };
  members?: { user: { id: number; name: string | null; email: string } }[];
};

const organizationWhere = { isOrganization: true, parentId: null };

function buildRow(overrides: Partial<OrganizationRow> = {}): OrganizationRow {
  return {
    id: 1,
    name: "Acme",
    slug: "acme",
    logoUrl: null,
    organizationSettings: { customDomain: "cal.acme.com" },
    _count: { orgUsers: 5, children: 2 },
    members: [{ user: { id: 10, name: "Owner", email: "owner@acme.com" } }],
    ...overrides,
  };
}

function notFoundError() {
  return new Prisma.PrismaClientKnownRequestError("x", { code: "P2025", clientVersion: "6" });
}

function buildRepository() {
  const team = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  };
  const user = { count: vi.fn() };
  const membership = { findMany: vi.fn() };
  const prismaClient = { team, user, membership } as unknown as PrismaClient;
  return { repository: new PrismaOrganizationRepository(prismaClient), team, user, membership };
}

describe("PrismaOrganizationRepository", () => {
  describe("reads", () => {
    it("findById filters to top-level organizations and maps the row", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(buildRow());

      const result = await repository.findById(1);

      const args = team.findFirst.mock.calls[0][0];
      expect(args.where).toEqual({ id: 1, ...organizationWhere });
      expect(args.select).not.toHaveProperty("include");
      expect(args).not.toHaveProperty("include");
      expect(args.select.members).toMatchObject({
        where: { role: "OWNER", accepted: true },
        orderBy: { id: "asc" },
      });
      expect(result).toEqual({
        id: 1,
        name: "Acme",
        slug: "acme",
        domain: "cal.acme.com",
        memberCount: 5,
        teamCount: 2,
        logoUrl: null,
        owners: [{ userId: 10, name: "Owner", email: "owner@acme.com" }],
      });
    });

    it("selects and maps the logo url", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(buildRow({ logoUrl: "https://cdn.acme.com/logo.png" }));

      const result = await repository.findById(1);

      expect(team.findFirst.mock.calls[0][0].select.logoUrl).toBe(true);
      expect(result?.logoUrl).toBe("https://cdn.acme.com/logo.png");
    });

    it("maps a missing settings row to a null domain", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(buildRow({ organizationSettings: null, members: [] }));

      const result = await repository.findById(1);

      expect(result?.domain).toBeNull();
      expect(result?.owners).toEqual([]);
    });

    it("returns null when no organization matches", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(null);

      expect(await repository.findById(1)).toBeNull();
      expect(await repository.findBySlug("acme")).toBeNull();
      expect(await repository.findByDomain("cal.acme.com")).toBeNull();
    });

    it("findBySlug filters to organizations and orders by id", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(buildRow());

      await repository.findBySlug("acme");

      expect(team.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: "acme", ...organizationWhere }, orderBy: { id: "asc" } })
      );
    });

    it("findByDomain filters on the custom domain", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(buildRow());

      await repository.findByDomain("cal.acme.com");

      expect(team.findFirst.mock.calls[0][0].where).toEqual({
        ...organizationWhere,
        organizationSettings: { customDomain: "cal.acme.com" },
      });
    });

    it("findDefault delegates to findByDomain", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(buildRow());
      const spy = vi.spyOn(repository, "findByDomain");

      const result = await repository.findDefault("cal.acme.com");

      expect(spy).toHaveBeenCalledWith("cal.acme.com");
      expect(result?.id).toBe(1);
    });
  });

  describe("list", () => {
    it("requests one extra row and sets nextCursor when there are more", async () => {
      const { repository, team } = buildRepository();
      team.findMany.mockResolvedValue([buildRow({ id: 1 }), buildRow({ id: 2 }), buildRow({ id: 3 })]);

      const result = await repository.list({ limit: 2 });

      const args = team.findMany.mock.calls[0][0];
      expect(args.take).toBe(3);
      expect(args.orderBy).toEqual({ id: "asc" });
      expect(args.where).toEqual(organizationWhere);
      expect(args.select).not.toHaveProperty("members");
      expect(args).not.toHaveProperty("include");
      expect(result.items.map((item) => item.id)).toEqual([1, 2]);
      expect(result.nextCursor).toBe(2);
      expect(result.items[0]).not.toHaveProperty("owners");
    });

    it("leaves nextCursor unset on the last page", async () => {
      const { repository, team } = buildRepository();
      team.findMany.mockResolvedValue([buildRow({ id: 1 })]);

      const result = await repository.list({ limit: 2 });

      expect(result.items).toHaveLength(1);
      expect(result).not.toHaveProperty("nextCursor");
    });

    it("applies the cursor as an id lower bound", async () => {
      const { repository, team } = buildRepository();
      team.findMany.mockResolvedValue([]);

      await repository.list({ limit: 10, cursor: 7 });

      expect(team.findMany.mock.calls[0][0].where).toEqual({ ...organizationWhere, id: { gt: 7 } });
    });

    it("searches name, slug and custom domain case-insensitively", async () => {
      const { repository, team } = buildRepository();
      team.findMany.mockResolvedValue([]);

      await repository.list({ limit: 10, search: "acm" });

      expect(team.findMany.mock.calls[0][0].where).toEqual({
        ...organizationWhere,
        OR: [
          { name: { contains: "acm", mode: "insensitive" } },
          { slug: { contains: "acm", mode: "insensitive" } },
          { organizationSettings: { customDomain: { contains: "acm", mode: "insensitive" } } },
        ],
      });
    });
  });

  describe("create", () => {
    it("creates the organization with nested settings in one call", async () => {
      const { repository, team } = buildRepository();
      team.create.mockResolvedValue(buildRow());

      const result = await repository.create({ name: "Acme", slug: "acme", domain: "cal.acme.com" });

      expect(team.create).toHaveBeenCalledTimes(1);
      expect(team.create.mock.calls[0][0].data).toEqual({
        name: "Acme",
        slug: "acme",
        isOrganization: true,
        organizationSettings: {
          create: {
            customDomain: "cal.acme.com",
            isOrganizationConfigured: true,
            isOrganizationVerified: true,
            allowSEOIndexing: true,
            orgAutoAcceptEmail: "",
          },
        },
      });
      expect(result.id).toBe(1);
    });
  });

  describe("update", () => {
    it("passes the logo url through, including a null to clear it", async () => {
      const { repository, team } = buildRepository();
      team.update.mockResolvedValue(buildRow());

      await repository.update(1, { logoUrl: "https://cdn.acme.com/logo.png" });
      await repository.update(1, { logoUrl: null });

      expect(team.update.mock.calls[0][0].data.logoUrl).toBe("https://cdn.acme.com/logo.png");
      expect(team.update.mock.calls[1][0].data.logoUrl).toBeNull();
    });

    it("upserts the settings only when a domain is given", async () => {
      const { repository, team } = buildRepository();
      team.update.mockResolvedValue(buildRow());

      await repository.update(1, { name: "Acme 2", domain: "cal2.acme.com" });

      const args = team.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 1, ...organizationWhere });
      expect(args.data).toEqual({
        name: "Acme 2",
        slug: undefined,
        organizationSettings: {
          upsert: {
            create: {
              customDomain: "cal2.acme.com",
              orgAutoAcceptEmail: "",
              isOrganizationConfigured: true,
              isOrganizationVerified: true,
              allowSEOIndexing: true,
            },
            update: { customDomain: "cal2.acme.com" },
          },
        },
      });
      expect(args.data.organizationSettings.upsert.update).not.toHaveProperty("allowSEOIndexing");
    });

    it("does not touch the settings without a domain", async () => {
      const { repository, team } = buildRepository();
      team.update.mockResolvedValue(buildRow());

      await repository.update(1, { slug: "acme-2" });

      expect(team.update.mock.calls[0][0].data).not.toHaveProperty("organizationSettings");
    });

    it("returns null when the organization does not exist", async () => {
      const { repository, team } = buildRepository();
      team.update.mockRejectedValue(notFoundError());

      expect(await repository.update(1, { name: "Acme" })).toBeNull();
    });

    it("rethrows other errors", async () => {
      const { repository, team } = buildRepository();
      const error = new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "6" });
      team.update.mockRejectedValue(error);

      await expect(repository.update(1, { slug: "taken" })).rejects.toBe(error);
    });
  });

  describe("delete", () => {
    it("deletes a top-level organization and returns its id", async () => {
      const { repository, team } = buildRepository();
      team.delete.mockResolvedValue({ id: 1 });

      const result = await repository.delete(1);

      expect(team.delete).toHaveBeenCalledWith({
        where: { id: 1, ...organizationWhere },
        select: { id: true },
      });
      expect(result).toEqual({ id: 1 });
    });

    it("returns null when the organization does not exist", async () => {
      const { repository, team } = buildRepository();
      team.delete.mockRejectedValue(notFoundError());

      expect(await repository.delete(1)).toBeNull();
    });

    it("rethrows other errors", async () => {
      const { repository, team } = buildRepository();
      const error = new Error("boom");
      team.delete.mockRejectedValue(error);

      await expect(repository.delete(1)).rejects.toBe(error);
    });
  });

  describe("counts and owners", () => {
    it("counts members by organizationId", async () => {
      const { repository, user } = buildRepository();
      user.count.mockResolvedValue(4);

      expect(await repository.countMembers(1)).toBe(4);
      expect(user.count).toHaveBeenCalledWith({ where: { organizationId: 1 } });
    });

    it("counts teams by parentId", async () => {
      const { repository, team } = buildRepository();
      team.count.mockResolvedValue(3);

      expect(await repository.countTeams(1)).toBe(3);
      expect(team.count).toHaveBeenCalledWith({ where: { parentId: 1 } });
    });

    it("finds accepted owners ordered by membership id", async () => {
      const { repository, membership } = buildRepository();
      membership.findMany.mockResolvedValue([
        { user: { id: 10, name: null, email: "owner@acme.com" } },
        { user: { id: 11, name: "Second", email: "second@acme.com" } },
      ]);

      const result = await repository.findOwners(1);

      expect(membership.findMany).toHaveBeenCalledWith({
        where: { teamId: 1, role: "OWNER", accepted: true },
        orderBy: { id: "asc" },
        select: { user: { select: { id: true, name: true, email: true } } },
      });
      expect(result).toEqual([
        { userId: 10, name: null, email: "owner@acme.com" },
        { userId: 11, name: "Second", email: "second@acme.com" },
      ]);
    });
  });

  describe("url lookups", () => {
    it("findDomainById filters to organizations and selects only the custom domain", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue({ organizationSettings: { customDomain: "cal.acme.com" } });

      expect(await repository.findDomainById(1)).toBe("cal.acme.com");
      expect(team.findFirst).toHaveBeenCalledWith({
        where: { id: 1, ...organizationWhere },
        select: { organizationSettings: { select: { customDomain: true } } },
      });
    });

    it("findDomainById returns null for a missing org, settings row or domain", async () => {
      const { repository, team } = buildRepository();
      team.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ organizationSettings: null })
        .mockResolvedValueOnce({ organizationSettings: { customDomain: null } });

      expect(await repository.findDomainById(1)).toBeNull();
      expect(await repository.findDomainById(1)).toBeNull();
      expect(await repository.findDomainById(1)).toBeNull();
    });

    it("findTeamParentById selects the parent and organization flag", async () => {
      const { repository, team } = buildRepository();
      team.findUnique.mockResolvedValue({ id: 5, parentId: 1, isOrganization: false });

      expect(await repository.findTeamParentById(5)).toEqual({ id: 5, parentId: 1, isOrganization: false });
      expect(team.findUnique).toHaveBeenCalledWith({
        where: { id: 5 },
        select: { id: true, parentId: true, isOrganization: true },
      });
    });

    it("findTeamParentById returns null for an unknown team", async () => {
      const { repository, team } = buildRepository();
      team.findUnique.mockResolvedValue(null);

      expect(await repository.findTeamParentById(5)).toBeNull();
    });
  });

  describe("findIdByVerifiedAutoAcceptEmailDomain", () => {
    it("returns the id of the verified organization auto-accepting the domain", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue({ id: 55 });

      expect(await repository.findIdByVerifiedAutoAcceptEmailDomain("acme.com")).toBe(55);
      expect(team.findFirst).toHaveBeenCalledWith({
        where: {
          ...organizationWhere,
          organizationSettings: { isOrganizationVerified: true, orgAutoAcceptEmail: "acme.com" },
        },
        select: { id: true },
      });
    });

    it("returns null when no organization matches", async () => {
      const { repository, team } = buildRepository();
      team.findFirst.mockResolvedValue(null);

      expect(await repository.findIdByVerifiedAutoAcceptEmailDomain("acme.com")).toBeNull();
    });
  });
});
