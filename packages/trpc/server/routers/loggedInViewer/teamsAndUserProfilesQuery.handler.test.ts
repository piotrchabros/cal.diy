import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { teamsAndUserProfilesQuery } from "./teamsAndUserProfilesQuery.handler";

const organization = {
  id: 1,
  isOrganization: true,
  logoUrl: "bluebee.png",
  name: "BlueBee",
  slug: "bluebee",
  metadata: {},
  parentId: null,
  parent: null,
  members: [],
};

const teamUnderOrg = {
  id: 2,
  isOrganization: false,
  logoUrl: "sales.png",
  name: "Sales",
  slug: "sales",
  metadata: {},
  parentId: 1,
  parent: { logoUrl: "bluebee.png", name: "BlueBee" },
  members: [],
};

async function query(includeOrg: boolean) {
  const findUnique = vi.fn().mockResolvedValue({
    avatarUrl: null,
    id: 1,
    username: "alice",
    name: "Alice",
    teams: [
      { role: MembershipRole.MEMBER, team: teamUnderOrg },
      { role: MembershipRole.OWNER, team: organization },
    ],
  });
  const prisma = { user: { findUnique } } as unknown as PrismaClient;
  const user = { id: 1 } as NonNullable<TrpcSessionUser>;

  const result = await teamsAndUserProfilesQuery({ ctx: { user, prisma }, input: { includeOrg } });

  return result.slice(1).map(({ teamId, slug, image }) => ({ teamId, slug, image }));
}

describe("teamsAndUserProfilesQuery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists the organization and the team's organization avatar when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await query(true)).toEqual([
      { teamId: 1, slug: "team/bluebee", image: "bluebee.png" },
      { teamId: 2, slug: "team/sales", image: "bluebee.png" },
    ]);
  });

  it("hides the organization and uses the team's own avatar when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await query(true)).toEqual([{ teamId: 2, slug: "team/sales", image: "sales.png" }]);
  });

  it("uses the team's own avatar without includeOrg when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(await query(false)).toEqual([{ teamId: 2, slug: "team/sales", image: "sales.png" }]);
  });

  it("uses the organization avatar without includeOrg when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(await query(false)).toEqual([{ teamId: 2, slug: "team/sales", image: "bluebee.png" }]);
  });
});
