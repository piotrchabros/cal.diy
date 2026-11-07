import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamAccessService } from "./TeamAccessService";

type Membership = { accepted: boolean; role: MembershipRole };

const TEAM_ID = 10;
const ORG_ID = 1;

describe("TeamAccessService.canViewTeam", () => {
  let memberships: Map<string, Membership>;
  let teams: Map<number, { parentId: number | null }>;
  let service: TeamAccessService;

  beforeEach(() => {
    memberships = new Map();
    teams = new Map([[TEAM_ID, { parentId: ORG_ID }]]);
    const findUniqueByUserIdAndTeamId = vi.fn(
      async ({ userId, teamId }: { userId: number; teamId: number }) =>
        memberships.get(`${userId}:${teamId}`) ?? null
    );
    const findBasicById = vi.fn(async ({ teamId }: { teamId: number }) => {
      const team = teams.get(teamId);
      return team
        ? { id: teamId, name: "", slug: null, logoUrl: null, isOrganization: false, ...team }
        : null;
    });
    service = new TeamAccessService({
      membershipRepo: { findUniqueByUserIdAndTeamId } as never,
      teamRepo: { findBasicById },
    });
  });

  const addMembership = (userId: number, teamId: number, membership: Membership) =>
    memberships.set(`${userId}:${teamId}`, membership);

  it("allows an accepted team member", async () => {
    addMembership(5, TEAM_ID, { accepted: true, role: MembershipRole.MEMBER });

    await expect(service.canViewTeam({ userId: 5, teamId: TEAM_ID })).resolves.toBe(true);
  });

  it("refuses a pending team invitee who is not an organization admin", async () => {
    addMembership(5, TEAM_ID, { accepted: false, role: MembershipRole.ADMIN });
    addMembership(5, ORG_ID, { accepted: true, role: MembershipRole.MEMBER });

    await expect(service.canViewTeam({ userId: 5, teamId: TEAM_ID })).resolves.toBe(false);
  });

  it.each([
    MembershipRole.ADMIN,
    MembershipRole.OWNER,
  ])("allows an accepted %s of the parent organization", async (role) => {
    addMembership(5, ORG_ID, { accepted: true, role });

    await expect(service.canViewTeam({ userId: 5, teamId: TEAM_ID })).resolves.toBe(true);
  });

  it("refuses a pending organization admin", async () => {
    addMembership(5, ORG_ID, { accepted: false, role: MembershipRole.OWNER });

    await expect(service.canViewTeam({ userId: 5, teamId: TEAM_ID })).resolves.toBe(false);
  });

  it("refuses a user of another organization", async () => {
    addMembership(5, 2, { accepted: true, role: MembershipRole.OWNER });

    await expect(service.canViewTeam({ userId: 5, teamId: TEAM_ID })).resolves.toBe(false);
  });

  it("refuses a team without a parent and an unknown team", async () => {
    teams.set(11, { parentId: null });

    await expect(service.canViewTeam({ userId: 5, teamId: 11 })).resolves.toBe(false);
    await expect(service.canViewTeam({ userId: 5, teamId: 999 })).resolves.toBe(false);
  });
});
