import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { TeamRepository } from "./TeamRepository";

function buildRepository() {
  const team = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) };
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
