import type { PrismaClient } from "@calcom/prisma/client";
import { describe, expect, it, vi } from "vitest";
import { EventTypeRepository } from "../eventTypeRepository";

const build = (rows: unknown[] = []) => {
  const findMany = vi.fn().mockResolvedValue(rows);
  const repo = new EventTypeRepository({ eventType: { findMany } } as unknown as PrismaClient);
  return { repo, findMany };
};

describe("EventTypeRepository.findPublicPersonalByUserIds", () => {
  it("returns [] without querying when there are no users", async () => {
    const { repo, findMany } = build();
    await expect(repo.findPublicPersonalByUserIds({ userIds: [] })).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries visible personal event types owned by or shared with the users", async () => {
    const { repo, findMany } = build();
    await repo.findPublicPersonalByUserIds({ userIds: [1, 2] });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      teamId: null,
      hidden: false,
      OR: [{ userId: { in: [1, 2] } }, { userId: { not: null }, users: { some: { id: { in: [1, 2] } } } }],
    });
    expect(args.select.users).toEqual({ where: { id: { in: [1, 2] } }, select: { id: true } });
    expect(args.orderBy).toEqual([{ position: "desc" }, { id: "asc" }]);
  });

  it("drops event types with invalid metadata and does not expose metadata", async () => {
    const base = { title: "t", slug: "s", description: null, length: 15, userId: 1, users: [] };
    const { repo } = build([
      { ...base, id: 1, metadata: {} },
      { ...base, id: 2, metadata: { multipleDuration: "nope" } },
      { ...base, id: 3, metadata: null },
    ]);

    const result = await repo.findPublicPersonalByUserIds({ userIds: [1] });

    expect(result.map((eventType) => eventType.id)).toEqual([1, 3]);
    expect(result[0]).not.toHaveProperty("metadata");
  });
});
