import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { TeamRepository } from "./TeamRepository";

function buildRepository() {
  const team = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findUnique: vi.fn().mockResolvedValue(null),
  };
  const prismaClient = { team } as unknown as PrismaClient;
  return { repository: new TeamRepository(prismaClient), team };
}

function teamRow(id: number, parent: { id: number; name: string } | null = null) {
  return { id, name: `Team ${id}`, slug: `team-${id}`, _count: { members: id * 2 }, parent };
}

describe("TeamRepository.findManyPaginated", () => {
  it("always excludes organizations and uses select without include", async () => {
    const { repository, team } = buildRepository();

    await repository.findManyPaginated({ limit: 10 });

    const args = team.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ isOrganization: false });
    expect(args).not.toHaveProperty("include");
    expect(args.select).toEqual({
      id: true,
      name: true,
      slug: true,
      _count: { select: { members: { where: { accepted: true } } } },
      parent: { select: { id: true, name: true } },
    });
    expect(args.orderBy).toEqual({ id: "asc" });
    expect(args.take).toBe(11);
    expect(team.count).toHaveBeenCalledWith({ where: { isOrganization: false } });
  });

  it("filters by parentId only when given", async () => {
    const { repository, team } = buildRepository();

    await repository.findManyPaginated({ parentId: 5, limit: 10 });
    await repository.findManyPaginated({ parentId: null, limit: 10 });

    expect(team.findMany.mock.calls[0][0].where).toEqual({ isOrganization: false, parentId: 5 });
    expect(team.findMany.mock.calls[1][0].where).not.toHaveProperty("parentId");
  });

  it("trims the search and matches name or slug case-insensitively", async () => {
    const { repository, team } = buildRepository();

    await repository.findManyPaginated({ search: "  acme ", limit: 10 });

    const expectedWhere = {
      isOrganization: false,
      OR: [
        { name: { contains: "acme", mode: "insensitive" } },
        { slug: { contains: "acme", mode: "insensitive" } },
      ],
    };
    expect(team.findMany.mock.calls[0][0].where).toEqual(expectedWhere);
    expect(team.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it("ignores an empty or whitespace-only search", async () => {
    const { repository, team } = buildRepository();

    await repository.findManyPaginated({ search: "   ", limit: 10 });
    await repository.findManyPaginated({ search: null, limit: 10 });

    expect(team.findMany.mock.calls[0][0].where).not.toHaveProperty("OR");
    expect(team.findMany.mock.calls[1][0].where).not.toHaveProperty("OR");
  });

  it("applies the cursor to the page query but not to the count", async () => {
    const { repository, team } = buildRepository();

    await repository.findManyPaginated({ cursor: 42, parentId: 3, limit: 10 });

    expect(team.findMany.mock.calls[0][0].where).toEqual({
      isOrganization: false,
      parentId: 3,
      id: { gt: 42 },
    });
    expect(team.count).toHaveBeenCalledWith({ where: { isOrganization: false, parentId: 3 } });
  });

  it("maps rows and returns the total without nextCursor when there are no more rows", async () => {
    const { repository, team } = buildRepository();
    team.findMany.mockResolvedValue([teamRow(1, { id: 9, name: "Acme" }), teamRow(2)]);
    team.count.mockResolvedValue(2);

    const result = await repository.findManyPaginated({ limit: 2 });

    expect(result).toEqual({
      items: [
        { id: 1, name: "Team 1", slug: "team-1", memberCount: 2, organization: { id: 9, name: "Acme" } },
        { id: 2, name: "Team 2", slug: "team-2", memberCount: 4, organization: null },
      ],
      total: 2,
    });
    expect(result).not.toHaveProperty("nextCursor");
  });

  it("returns nextCursor as the last returned id when there are more rows", async () => {
    const { repository, team } = buildRepository();
    team.findMany.mockResolvedValue([teamRow(1), teamRow(2), teamRow(3)]);
    team.count.mockResolvedValue(7);

    const result = await repository.findManyPaginated({ limit: 2 });

    expect(result.items.map((item) => item.id)).toEqual([1, 2]);
    expect(result.nextCursor).toBe(2);
    expect(result.total).toBe(7);
  });
});

describe("TeamRepository.findIdBySlug", () => {
  function buildSlugRepository() {
    const team = { findFirst: vi.fn().mockResolvedValue(null) };
    return { repository: new TeamRepository({ team } as unknown as PrismaClient), team };
  }

  it("searches every team when no parent is given", async () => {
    const { repository, team } = buildSlugRepository();

    await repository.findIdBySlug({ slug: "sales" });

    expect(team.findFirst).toHaveBeenCalledWith({ where: { slug: "sales" }, select: { id: true } });
  });

  it("filters by parent, including teams outside any organization, and can exclude a team", async () => {
    const { repository, team } = buildSlugRepository();

    await repository.findIdBySlug({ slug: "sales", parentId: 4, excludeTeamId: 9 });
    await repository.findIdBySlug({ slug: "sales", parentId: null });

    expect(team.findFirst).toHaveBeenNthCalledWith(1, {
      where: { slug: "sales", parentId: 4, NOT: { id: 9 } },
      select: { id: true },
    });
    expect(team.findFirst).toHaveBeenNthCalledWith(2, {
      where: { slug: "sales", parentId: null },
      select: { id: true },
    });
  });
});

describe("TeamRepository.createWithOwner", () => {
  it("creates the team with the owner as an accepted OWNER and omits a missing parent", async () => {
    const team = { create: vi.fn().mockResolvedValue({ id: 1 }) };
    const repository = new TeamRepository({ team } as unknown as PrismaClient);

    await repository.createWithOwner({
      name: "Sales",
      slug: "sales",
      bio: null,
      logoUrl: null,
      parentId: null,
      ownerUserId: 7,
    });

    expect(team.create).toHaveBeenCalledWith({
      select: { id: true, name: true, slug: true, bio: true, logoUrl: true },
      data: {
        name: "Sales",
        slug: "sales",
        bio: null,
        logoUrl: null,
        members: { create: { userId: 7, role: "OWNER", accepted: true } },
      },
    });
  });
});

describe("TeamRepository team profile queries", () => {
  function buildProfileRepository() {
    const team = {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: 3 }),
      delete: vi.fn().mockResolvedValue({ id: 3 }),
    };
    return { repository: new TeamRepository({ team } as unknown as PrismaClient), team };
  }

  it("findProfileById selects the profile fields and whether the row is an organization", async () => {
    const { repository, team } = buildProfileRepository();

    await repository.findProfileById({ teamId: 3 });

    expect(team.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        bio: true,
        metadata: true,
        parentId: true,
        isOrganization: true,
      },
    });
  });

  it("updateProfile writes the given fields and returns the profile fields", async () => {
    const { repository, team } = buildProfileRepository();
    const data = { name: "Sales", slug: "sales", bio: null, logoUrl: null, metadata: { showMap: true } };

    await repository.updateProfile({ teamId: 3, data });

    expect(team.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data,
      select: { id: true, name: true, slug: true, logoUrl: true, bio: true, metadata: true, parentId: true },
    });
  });

  it("findPublicBySlugIncludeEventTypes filters by parent only when one is given", async () => {
    const { repository, team } = buildProfileRepository();

    await repository.findPublicBySlugIncludeEventTypes({ slug: "sales" });
    await repository.findPublicBySlugIncludeEventTypes({ slug: "sales", parentId: 4 });

    expect(team.findFirst.mock.calls[0][0].where).toEqual({ slug: "sales", isPrivate: false });
    expect(team.findFirst.mock.calls[1][0].where).toEqual({ slug: "sales", isPrivate: false, parentId: 4 });
    expect(team.findFirst.mock.calls[0][0].select.eventTypes.where).toEqual({ hidden: false });
  });

  it("deleteById deletes one team and returns only its id", async () => {
    const { repository, team } = buildProfileRepository();

    await expect(repository.deleteById({ teamId: 3 })).resolves.toEqual({ id: 3 });
    expect(team.delete).toHaveBeenCalledWith({ where: { id: 3 }, select: { id: true } });
  });
});

describe("TeamRepository.findIsPlatformById", () => {
  it("selects only the platform flag", async () => {
    const { repository, team } = buildRepository();
    team.findUnique.mockResolvedValue({ isPlatform: true });

    await expect(repository.findIsPlatformById({ teamId: 7 })).resolves.toEqual({ isPlatform: true });
    expect(team.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { isPlatform: true },
    });
  });

  it("returns null for an unknown team", async () => {
    const { repository } = buildRepository();

    await expect(repository.findIsPlatformById({ teamId: 999 })).resolves.toBeNull();
  });
});

describe("TeamRepository.updateLogoUrl", () => {
  it("writes only the logo URL", async () => {
    const team = { update: vi.fn().mockResolvedValue({ id: 7 }) };
    const repository = new TeamRepository({ team } as unknown as PrismaClient);

    await repository.updateLogoUrl({ teamId: 7, logoUrl: "https://cdn.example.com/logo.png" });

    expect(team.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { logoUrl: "https://cdn.example.com/logo.png" },
      select: { id: true },
    });
  });
});
