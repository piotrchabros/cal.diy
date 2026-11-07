import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaTempOrgRedirectRepository } from "./PrismaTempOrgRedirectRepository";

function buildRepository() {
  const tempOrgRedirect = { findMany: vi.fn(), updateMany: vi.fn() };
  const prismaClient = { tempOrgRedirect } as unknown as PrismaClient;
  return { repository: new PrismaTempOrgRedirectRepository(prismaClient), tempOrgRedirect };
}

describe("PrismaTempOrgRedirectRepository", () => {
  describe("findEnabledByFromSlugs", () => {
    it("queries enabled redirects for the deduplicated slugs and returns rows unchanged", async () => {
      const { repository, tempOrgRedirect } = buildRepository();
      const rows = [
        { from: "alice", toUrl: "https://acme.cal.com/alice" },
        { from: "bob", toUrl: "https://acme.cal.com/bob" },
      ];
      tempOrgRedirect.findMany.mockResolvedValue(rows);

      const result = await repository.findEnabledByFromSlugs({
        fromOrgId: 0,
        type: "User",
        fromSlugs: ["alice", "bob", "alice"],
      });

      expect(tempOrgRedirect.findMany).toHaveBeenCalledWith({
        where: { fromOrgId: 0, type: "User", from: { in: ["alice", "bob"] }, enabled: true },
        select: { from: true, toUrl: true },
      });
      expect(result).toBe(rows);
    });

    it("returns an empty list without querying when no slugs are given", async () => {
      const { repository, tempOrgRedirect } = buildRepository();

      const result = await repository.findEnabledByFromSlugs({
        fromOrgId: 0,
        type: "Team",
        fromSlugs: [],
      });

      expect(result).toEqual([]);
      expect(tempOrgRedirect.findMany).not.toHaveBeenCalled();
    });
  });

  describe("disableByFrom", () => {
    it("disables enabled redirects of the given types and returns the count", async () => {
      const { repository, tempOrgRedirect } = buildRepository();
      tempOrgRedirect.updateMany.mockResolvedValue({ count: 2 });

      const result = await repository.disableByFrom({
        fromOrgId: 3,
        from: "sales",
        types: ["Team", "TeamEventType"],
      });

      expect(tempOrgRedirect.updateMany).toHaveBeenCalledWith({
        where: { fromOrgId: 3, from: "sales", type: { in: ["Team", "TeamEventType"] }, enabled: true },
        data: { enabled: false },
      });
      expect(result).toBe(2);
    });

    it("returns 0 without querying when no types are given", async () => {
      const { repository, tempOrgRedirect } = buildRepository();

      expect(await repository.disableByFrom({ fromOrgId: 3, from: "sales", types: [] })).toBe(0);
      expect(tempOrgRedirect.updateMany).not.toHaveBeenCalled();
    });
  });
});
