import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";
import { availabilityUserSelect } from "@calcom/prisma/selects/user";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@calcom/prisma", () => ({
  prisma: { membership: { findMany } },
  // Value imports used by the repository module; re-exported here so the module loads.
  availabilityUserSelect,
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

  it("findByTeamIdForAvailability selects the membership scalars plus the availability user subtree", async () => {
    await MembershipRepository.findByTeamIdForAvailability({ teamId: 3 });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty("include");
    expect(args.where).toEqual({ teamId: 3 });
    expect(args.select.user).toEqual({
      select: {
        credentials: { select: credentialForCalendarServiceSelect },
        ...availabilityUserSelect,
      },
    });
  });

  it("findMembershipsCreatedAfterTimeIncludeUser selects the membership scalars plus id/name/email", async () => {
    const time = new Date("2026-01-01T00:00:00.000Z");
    await MembershipRepository.findMembershipsCreatedAfterTimeIncludeUser({
      organizationId: 1,
      time,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty("include");
    expect(args.where).toEqual({ teamId: 1, createdAt: { gt: time }, accepted: true });
    expect(args.select.user).toEqual({ select: { email: true, name: true, id: true } });
  });
});
