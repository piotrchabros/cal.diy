import { describe, expect, it } from "vitest";
import { InMemoryNotetakerMembershipLookup } from "./InMemoryNotetakerMembershipLookup";

describe("InMemoryNotetakerMembershipLookup", () => {
  it("treats unaccepted and removed members as non-members", async () => {
    const lookup = new InMemoryNotetakerMembershipLookup();
    lookup.addMember({ teamId: 1, userId: 1 });
    lookup.addMember({ teamId: 1, userId: 2, accepted: false });
    lookup.addMember({ teamId: 1, userId: 3 });
    lookup.removeMember({ teamId: 1, userId: 3 });
    expect(await lookup.isAcceptedMember({ teamId: 1, userId: 1 })).toBe(true);
    expect(await lookup.isAcceptedMember({ teamId: 1, userId: 2 })).toBe(false);
    expect(await lookup.isAcceptedMember({ teamId: 1, userId: 3 })).toBe(false);
    expect(await lookup.listAcceptedTeamIds({ userId: 1 })).toEqual([1]);
    expect(await lookup.listAcceptedTeamIds({ userId: 2 })).toEqual([]);
  });

  it("returns the accepted subset of the given user ids", async () => {
    const lookup = new InMemoryNotetakerMembershipLookup();
    lookup.addMember({ teamId: 1, userId: 5 });
    lookup.addMember({ teamId: 1, userId: 6, accepted: false });
    lookup.addMember({ teamId: 2, userId: 7 });
    expect(await lookup.findAcceptedUserIds({ teamId: 1, userIds: [5, 6, 7] })).toEqual([5]);
    expect(await lookup.findAcceptedUserIds({ teamId: 1, userIds: [] })).toEqual([]);
  });

  it("searches name and email case-insensitively and pages by user id", async () => {
    const lookup = new InMemoryNotetakerMembershipLookup();
    lookup.addMember({ teamId: 1, userId: 1, name: "Alice Smith" });
    lookup.addMember({ teamId: 1, userId: 2, name: "Bob", email: "ALICE.b@example.com" });
    lookup.addMember({ teamId: 1, userId: 3, name: "Carol" });
    const first = await lookup.searchAcceptedMembers({ teamId: 1, search: "alice", cursor: null, limit: 1 });
    expect(first.items.map((item) => item.userId)).toEqual([1]);
    expect(first.nextCursor).toBe(1);
    const second = await lookup.searchAcceptedMembers({ teamId: 1, search: "alice", cursor: 1, limit: 1 });
    expect(second.items.map((item) => item.userId)).toEqual([2]);
    expect(second.nextCursor).toBeNull();
  });

  it("defaults the email from the user id", async () => {
    const lookup = new InMemoryNotetakerMembershipLookup();
    lookup.addMember({ teamId: 1, userId: 9 });
    const page = await lookup.searchAcceptedMembers({ teamId: 1, search: null, cursor: null, limit: 10 });
    expect(page.items).toEqual([{ userId: 9, name: null, email: "user9@example.com", avatarUrl: null }]);
  });
});
