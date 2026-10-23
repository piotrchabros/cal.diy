import { describe, expect, it, vi } from "vitest";
import { TeamPublicMembersService } from "./TeamPublicMembersService";

type Member = { id: number; username: string | null; name: string | null; avatarUrl: string | null };
type Row = {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  length: number;
  userId: number | null;
  users: { id: number }[];
};

const member = (id: number, overrides: Partial<Member> = {}): Member => ({
  id,
  username: `user${id}`,
  name: `User ${id}`,
  avatarUrl: null,
  ...overrides,
});

const row = (id: number, overrides: Partial<Row> = {}): Row => ({
  id,
  title: `Event ${id}`,
  slug: `event-${id}`,
  description: null,
  length: 30,
  userId: null,
  users: [],
  ...overrides,
});

const build = (members: Member[], rows: Row[]) => {
  const findAcceptedPublicMembersByTeamId = vi.fn().mockResolvedValue(members.map((user) => ({ user })));
  const findPublicPersonalByUserIds = vi.fn().mockResolvedValue(rows);
  const service = new TeamPublicMembersService({
    membershipRepo: { findAcceptedPublicMembersByTeamId },
    eventTypeRepo: { findPublicPersonalByUserIds },
  });
  return { service, findAcceptedPublicMembersByTeamId, findPublicPersonalByUserIds };
};

describe("TeamPublicMembersService.listByTeamId", () => {
  it("returns [] without querying event types for an empty team", async () => {
    const { service, findPublicPersonalByUserIds } = build([], []);
    await expect(service.listByTeamId({ teamId: 10 })).resolves.toEqual([]);
    expect(findPublicPersonalByUserIds).not.toHaveBeenCalled();
  });

  it("queries event types once for all members", async () => {
    const { service, findPublicPersonalByUserIds } = build([member(1), member(2)], [row(1, { userId: 1 })]);
    await service.listByTeamId({ teamId: 10 });
    expect(findPublicPersonalByUserIds).toHaveBeenCalledOnce();
    expect(findPublicPersonalByUserIds).toHaveBeenCalledWith({ userIds: [1, 2] });
  });

  it("attributes an event type to its owner and to users listed on the relation", async () => {
    const { service } = build([member(1), member(2)], [row(5, { userId: 1, users: [{ id: 2 }] })]);
    const result = await service.listByTeamId({ teamId: 10 });
    expect(result.map((m) => [m.username, m.eventTypes.map((e) => e.id)])).toEqual([
      ["user1", [5]],
      ["user2", [5]],
    ]);
  });

  it("does not repeat an event type when the owner is also in the relation", async () => {
    const { service } = build([member(1)], [row(5, { userId: 1, users: [{ id: 1 }] })]);
    const [result] = await service.listByTeamId({ teamId: 10 });
    expect(result.eventTypes).toHaveLength(1);
  });

  it("drops members without public event types", async () => {
    const { service } = build([member(1), member(2)], [row(5, { userId: 2 })]);
    const result = await service.listByTeamId({ teamId: 10 });
    expect(result.map((m) => m.username)).toEqual(["user2"]);
  });

  it("falls back to the username when the name is blank", async () => {
    const { service } = build(
      [member(1, { name: "   " }), member(2, { name: null })],
      [row(5, { userId: 1 }), row(6, { userId: 2 })]
    );
    const result = await service.listByTeamId({ teamId: 10 });
    expect(result.map((m) => m.name)).toEqual(["user1", "user2"]);
  });

  it("uses the member avatar when set and an absolute fallback otherwise", async () => {
    const { service } = build(
      [member(1, { avatarUrl: "https://cdn.example.com/a.png" }), member(2)],
      [row(5, { userId: 1 }), row(6, { userId: 2 })]
    );
    const result = await service.listByTeamId({ teamId: 10 });
    expect(result[0].avatarUrl).toBe("https://cdn.example.com/a.png");
    expect(result[1].avatarUrl).toMatch(/^https?:\/\//);
  });

  it("sorts members by name ignoring case and keeps event order", async () => {
    const { service } = build(
      [member(1, { name: "zoe" }), member(2, { name: "Adam" })],
      [row(9, { userId: 2 }), row(3, { userId: 2 }), row(4, { userId: 1 })]
    );
    const result = await service.listByTeamId({ teamId: 10 });
    expect(result.map((m) => m.name)).toEqual(["Adam", "zoe"]);
    expect(result[0].eventTypes.map((e) => e.id)).toEqual([9, 3]);
  });

  it("exposes neither ids nor emails on members or event types", async () => {
    const { service } = build([member(1)], [row(5, { userId: 1 })]);
    const [result] = await service.listByTeamId({ teamId: 10 });
    expect(Object.keys(result).sort()).toEqual(["avatarUrl", "eventTypes", "name", "username"]);
    expect(Object.keys(result.eventTypes[0]).sort()).toEqual([
      "description",
      "id",
      "length",
      "slug",
      "title",
    ]);
  });
});
