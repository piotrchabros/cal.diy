import { beforeEach, describe, expect, it, vi } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@calcom/prisma", () => ({
  prisma: { membership: { findMany } },
}));

// T527: pins the select-only shape of the audited queries. Any added relation must be a `select`
// with explicitly listed fields, never an `include`.
describe("MembershipRepository select-only audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
  });

  it("findAllByUpIdIncludeTeam selects only the consumed membership and team fields", async () => {
    await MembershipRepository.findAllByUpIdIncludeTeam({ upId: "usr-7" }, { where: { accepted: true } });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty("include");
    expect(Object.keys(args.select).sort()).toEqual(
      ["accepted", "id", "role", "team", "teamId", "userId"].sort()
    );
    expect(Object.keys(args.select.team.select).sort()).toEqual(
      ["id", "isOrganization", "logoUrl", "metadata", "name", "parent", "parentId", "slug"].sort()
    );
    expect(args.select.team.select.parent).toEqual({
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        parentId: true,
        metadata: true,
      },
    });
  });
});
