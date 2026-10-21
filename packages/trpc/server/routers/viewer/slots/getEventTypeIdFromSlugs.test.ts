import { describe, expect, it, vi } from "vitest";
import { getEventTypeIdFromSlugs } from "./getEventTypeIdFromSlugs";

type Deps = Parameters<typeof getEventTypeIdFromSlugs>[0];

const buildDeps = () => {
  const findFirstEventTypeId = vi.fn<Deps["eventTypeRepo"]["findFirstEventTypeId"]>();
  const findFirstIdByTeamSlugAndSlug = vi.fn<Deps["eventTypeRepo"]["findFirstIdByTeamSlugAndSlug"]>();
  const getUserIdByUsername = vi.fn<Deps["getUserIdByUsername"]>();
  const deps: Deps = {
    eventTypeRepo: { findFirstEventTypeId, findFirstIdByTeamSlugAndSlug },
    getUserIdByUsername,
  };
  return { deps, findFirstEventTypeId, findFirstIdByTeamSlugAndSlug, getUserIdByUsername };
};

describe("getEventTypeIdFromSlugs", () => {
  it("resolves a team event by team slug and never treats the owner as a user", async () => {
    const { deps, findFirstEventTypeId, findFirstIdByTeamSlugAndSlug, getUserIdByUsername } = buildDeps();
    findFirstIdByTeamSlugAndSlug.mockResolvedValue({ id: 42 });

    const result = await getEventTypeIdFromSlugs(deps, {
      ownerSlug: "acme",
      eventTypeSlug: "intro",
      isTeamEvent: true,
    });

    expect(result).toBe(42);
    expect(findFirstIdByTeamSlugAndSlug).toHaveBeenCalledWith({ teamSlug: "acme", slug: "intro" });
    expect(getUserIdByUsername).not.toHaveBeenCalled();
    expect(findFirstEventTypeId).not.toHaveBeenCalled();
  });

  it("returns null when the team event does not exist", async () => {
    const { deps, findFirstIdByTeamSlugAndSlug } = buildDeps();
    findFirstIdByTeamSlugAndSlug.mockResolvedValue(null);

    const result = await getEventTypeIdFromSlugs(deps, {
      ownerSlug: "acme",
      eventTypeSlug: "missing",
      isTeamEvent: true,
    });

    expect(result).toBeNull();
  });

  it("resolves a user event by user id and slug", async () => {
    const { deps, findFirstEventTypeId, findFirstIdByTeamSlugAndSlug, getUserIdByUsername } = buildDeps();
    getUserIdByUsername.mockResolvedValue(7);
    findFirstEventTypeId.mockResolvedValue({ id: 99 });

    const result = await getEventTypeIdFromSlugs(deps, {
      ownerSlug: "alice",
      eventTypeSlug: "intro",
      isTeamEvent: false,
    });

    expect(result).toBe(99);
    expect(getUserIdByUsername).toHaveBeenCalledWith("alice");
    expect(findFirstEventTypeId).toHaveBeenCalledWith({ slug: "intro", userId: 7 });
    expect(findFirstIdByTeamSlugAndSlug).not.toHaveBeenCalled();
  });

  it("returns null without a slug-only lookup when the user does not exist", async () => {
    const { deps, findFirstEventTypeId, getUserIdByUsername } = buildDeps();
    getUserIdByUsername.mockResolvedValue(undefined);

    const result = await getEventTypeIdFromSlugs(deps, {
      ownerSlug: "ghost",
      eventTypeSlug: "intro",
      isTeamEvent: false,
    });

    expect(result).toBeNull();
    expect(findFirstEventTypeId).not.toHaveBeenCalled();
  });

  it("returns null when the user exists but the event type does not", async () => {
    const { deps, findFirstEventTypeId, getUserIdByUsername } = buildDeps();
    getUserIdByUsername.mockResolvedValue(7);
    findFirstEventTypeId.mockResolvedValue(null);

    const result = await getEventTypeIdFromSlugs(deps, {
      ownerSlug: "alice",
      eventTypeSlug: "missing",
      isTeamEvent: false,
    });

    expect(result).toBeNull();
  });

  it("passes slugs with non-ASCII characters through unchanged", async () => {
    const { deps, findFirstEventTypeId, getUserIdByUsername } = buildDeps();
    getUserIdByUsername.mockResolvedValue(7);
    findFirstEventTypeId.mockResolvedValue({ id: 5 });

    await getEventTypeIdFromSlugs(deps, {
      ownerSlug: "alice",
      eventTypeSlug: "spotkanie-zespołowe",
      isTeamEvent: false,
    });

    expect(findFirstEventTypeId).toHaveBeenCalledWith({ slug: "spotkanie-zespołowe", userId: 7 });
  });
});
