import { describe, expect, it, vi } from "vitest";
import { MembershipRepositoryNotetakerLookup } from "./MembershipRepositoryNotetakerLookup";

type SearchResult = Awaited<
  ReturnType<ConstructorParameters<typeof MembershipRepositoryNotetakerLookup>[0]["searchMembers"]>
>;

const createLookup = (overrides: { searchResult?: SearchResult } = {}) => {
  const hasMembership = vi.fn().mockResolvedValue(true);
  const findAllByUserId = vi.fn().mockResolvedValue([
    { teamId: 3, role: "MEMBER", team: { id: 3, parentId: null, isOrganization: false } },
    { teamId: 9, role: "ADMIN", team: { id: 9, parentId: 1, isOrganization: false } },
  ]);
  const searchMembers = vi.fn().mockResolvedValue(
    overrides.searchResult ?? {
      memberships: [
        {
          role: "MEMBER",
          user: {
            id: 4,
            name: "Ann",
            email: "ann@example.com",
            avatarUrl: null,
            username: "ann",
            defaultScheduleId: 7,
          },
        },
      ],
      nextCursor: undefined,
      hasMore: false,
    }
  );
  const lookup = new MembershipRepositoryNotetakerLookup({ hasMembership, findAllByUserId, searchMembers });
  return { lookup, hasMembership, findAllByUserId, searchMembers };
};

describe("MembershipRepositoryNotetakerLookup", () => {
  it("delegates isAcceptedMember to hasMembership", async () => {
    const { lookup, hasMembership } = createLookup();
    await expect(lookup.isAcceptedMember({ userId: 1, teamId: 2 })).resolves.toBe(true);
    expect(hasMembership).toHaveBeenCalledWith({ userId: 1, teamId: 2 });
  });

  it("lists only accepted team ids", async () => {
    const { lookup, findAllByUserId } = createLookup();
    await expect(lookup.listAcceptedTeamIds({ userId: 1 })).resolves.toEqual([3, 9]);
    expect(findAllByUserId).toHaveBeenCalledWith({ userId: 1, filters: { accepted: true } });
  });

  it("gives [] without a query for no user ids", async () => {
    const { lookup, searchMembers } = createLookup();
    await expect(lookup.findAcceptedUserIds({ teamId: 2, userIds: [] })).resolves.toEqual([]);
    expect(searchMembers).not.toHaveBeenCalled();
  });

  it("maps the matching members to user ids", async () => {
    const { lookup, searchMembers } = createLookup();
    await expect(lookup.findAcceptedUserIds({ teamId: 2, userIds: [4, 5] })).resolves.toEqual([4]);
    expect(searchMembers).toHaveBeenCalledWith({ teamId: 2, limit: 2, memberUserIds: [4, 5] });
  });

  it("passes only id, name, email and avatar on from a search", async () => {
    const { lookup } = createLookup();
    const page = await lookup.searchAcceptedMembers({ teamId: 2, search: "an", cursor: null, limit: 20 });
    expect(page).toEqual({
      items: [{ userId: 4, name: "Ann", email: "ann@example.com", avatarUrl: null }],
      nextCursor: null,
    });
    expect(Object.keys(page.items[0]).sort()).toEqual(["avatarUrl", "email", "name", "userId"]);
  });

  it("carries the next cursor through", async () => {
    const { lookup } = createLookup({ searchResult: { memberships: [], nextCursor: 12, hasMore: true } });
    const page = await lookup.searchAcceptedMembers({ teamId: 2, search: null, cursor: 3, limit: 1 });
    expect(page.nextCursor).toBe(12);
  });
});
