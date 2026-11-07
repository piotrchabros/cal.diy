import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import type { PrismaClient } from "@calcom/prisma";
import { CreationSource, MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@calcom/app-store/delegationCredential", () => ({
  enrichHostsWithDelegationCredentials: vi.fn(),
  getUsersCredentialsIncludeServiceAccountKey: vi.fn(),
  getCredentialForSelectedCalendar: vi.fn(),
}));

vi.mock("@calcom/i18n/server", () => {
  return {
    getTranslation: async (locale: string, namespace: string) => {
      const t = (key: string) => key;
      t.locale = locale;
      t.namespace = namespace;
      return t;
    },
  };
});

describe("UserRepository", () => {
  beforeEach(() => {
    prismock;
  });

  describe("create", () => {
    test("Should create a user without a password", async () => {
      const user = await new UserRepository(prismock).create({
        username: "test",
        email: "test@example.com",
        organizationId: null,
        creationSource: CreationSource.WEBAPP,
        locked: false,
      });

      expect(user).toEqual(
        expect.objectContaining({
          username: "test",
          email: "test@example.com",
          organizationId: null,
          creationSource: CreationSource.WEBAPP,
          locked: false,
        })
      );

      const password = await prismock.userPassword.findUnique({
        where: {
          userId: user.id,
        },
      });

      expect(password).toBeNull();
    });

    test("If locked param is passed, user should be locked", async () => {
      const user = await new UserRepository(prismock).create({
        username: "test",
        email: "test@example.com",
        organizationId: null,
        creationSource: CreationSource.WEBAPP,
        locked: true,
      });

      const userQuery = await prismock.user.findUnique({
        where: {
          email: "test@example.com",
        },
        select: {
          locked: true,
        },
      });

      expect(userQuery).toEqual(
        expect.objectContaining({
          locked: true,
        })
      );
    });

    test("If organizationId is passed, user should be associated with the organization", async () => {
      const organizationId = 123;
      const username = "test";

      const user = await new UserRepository(prismock).create({
        username,
        email: "test@example.com",
        organizationId,
        creationSource: CreationSource.WEBAPP,
        locked: true,
      });

      expect(user).toEqual(
        expect.objectContaining({
          organizationId,
        })
      );

      const profile = await prismock.profile.findFirst({
        where: {
          organizationId,
          username,
        },
      });

      expect(profile).toEqual(
        expect.objectContaining({
          organizationId,
          username,
        })
      );
    });
  });
});
describe("listUsers", () => {
  test("Should return all users matching search term with default pagination", async () => {
    await new UserRepository(prismock).create({
      username: "alice",
      email: "alice@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });
    await new UserRepository(prismock).create({
      username: "bob",
      email: "bob@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });
    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: null,
      cursor: null,
      limit: 10,
    });

    expect(users).toHaveLength(2);
    expect(total).toEqual(2);
  });
  test("Should filter users by searchTerm matching username (case-insensitive)", async () => {
    await new UserRepository(prismock).create({
      username: "alice",
      email: "alice@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });
    await new UserRepository(prismock).create({
      username: "bob",
      email: "bob@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: "BOB",
      cursor: null,
      limit: 10,
    });

    expect(users).toHaveLength(1);
    expect(users[0]).toEqual(
      expect.objectContaining({
        username: "bob",
      })
    );
    const result = await new UserRepository(prismock).listUsers({
      searchTerm: "ALiCE",
      cursor: null,
      limit: 10,
    });

    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toEqual(
      expect.objectContaining({
        username: "alice",
      })
    );
  });

  test("Should include both locked and unlocked users", async () => {
    await new UserRepository(prismock).create({
      username: "locked-user",
      email: "locked@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: true,
    });
    await new UserRepository(prismock).create({
      username: "unlocked-user",
      email: "unlocked@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: null,
      cursor: null,
      limit: 10,
    });

    expect(total).toEqual(2);
    expect(users.map((u) => u.locked).sort()).toEqual([false, true]);
  });

  test("Should respect limit by returning limit + 1 rows for cursor calculation", async () => {
    for (let i = 0; i < 5; i++) {
      await new UserRepository(prismock).create({
        username: `user${i}`,
        email: `user${i}@example.com`,
        organizationId: null,
        creationSource: CreationSource.WEBAPP,
        locked: false,
      });
    }

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: null,
      cursor: null,
      limit: 3,
    });
    // take = limit + 1, so up to 4 rows come back to let the caller detect "has more"
    expect(users.length).toBeLessThanOrEqual(4);
    expect(total).toEqual(5);
  });

  test("Should return all users when limit is not passed (no cap)", async () => {
    for (let i = 0; i < 5; i++) {
      await new UserRepository(prismock).create({
        username: `nolimituser${i}`,
        email: `nolimituser${i}@example.com`,
        organizationId: null,
        creationSource: CreationSource.WEBAPP,
        locked: false,
      });
    }

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: null,
      cursor: null,
      limit: undefined,
    });

    expect(users).toHaveLength(5);
    expect(total).toEqual(5);
  });

  test("Should return empty array when no users match searchTerm", async () => {
    await new UserRepository(prismock).create({
      username: "alice",
      email: "alice@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: "nonexistent-term-xyz",
      cursor: null,
      limit: 10,
    });

    expect(users).toEqual([]);
    expect(total).toEqual(0);
  });
});
describe("listUsers organization filter", () => {
  async function seedUsersAcrossOrganizations() {
    const orgA = await prismock.team.create({
      data: { name: "Org A", slug: "org-a-list", isOrganization: true },
    });
    const orgB = await prismock.team.create({
      data: { name: "Org B", slug: "org-b-list", isOrganization: true },
    });
    const repo = new UserRepository(prismock);
    await repo.create({
      username: "anna",
      email: "anna@a.example.com",
      organizationId: orgA.id,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });
    await repo.create({
      username: "adam",
      email: "adam@a.example.com",
      organizationId: orgA.id,
      creationSource: CreationSource.WEBAPP,
      locked: true,
    });
    await repo.create({
      username: "bella",
      email: "bella@b.example.com",
      organizationId: orgB.id,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });
    await repo.create({
      username: "nora",
      email: "nora@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });
    return { orgA, orgB };
  }

  test("Should return only the given organization's users, including locked ones", async () => {
    const { orgA } = await seedUsersAcrossOrganizations();

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: null,
      cursor: null,
      limit: 10,
      organizationId: orgA.id,
    });

    expect(users.map((u) => u.username).sort()).toEqual(["adam", "anna"]);
    expect(total).toEqual(2);
  });

  test("Should combine the organization filter with the search term", async () => {
    const { orgA } = await seedUsersAcrossOrganizations();

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: "ANNA",
      cursor: null,
      limit: 10,
      organizationId: orgA.id,
    });

    expect(users.map((u) => u.username)).toEqual(["anna"]);
    expect(total).toEqual(1);

    const outside = await new UserRepository(prismock).listUsers({
      searchTerm: "bella",
      cursor: null,
      limit: 10,
      organizationId: orgA.id,
    });

    expect(outside.users).toEqual([]);
    expect(outside.total).toEqual(0);
  });

  test("Should return every user with their organization when no filter is given", async () => {
    const { orgA, orgB } = await seedUsersAcrossOrganizations();

    const { users, total } = await new UserRepository(prismock).listUsers({
      searchTerm: null,
      cursor: null,
      limit: 10,
      organizationId: null,
    });

    expect(total).toEqual(4);
    const organizationByUsername = Object.fromEntries(users.map((u) => [u.username, u.organization]));
    expect(organizationByUsername).toEqual({
      anna: { id: orgA.id, name: "Org A" },
      adam: { id: orgA.id, name: "Org A" },
      bella: { id: orgB.id, name: "Org B" },
      nora: null,
    });
  });
});
describe("organization membership of invited users", () => {
  test("createInvitedWithPendingTeamMembership stores organizationId without creating a profile", async () => {
    const team = await prismock.team.create({ data: { name: "Org Team", slug: "org-team-invite" } });
    const organizationId = 456;

    const { id } = await new UserRepository(prismock).createInvitedWithPendingTeamMembership({
      email: "Invitee@Example.com",
      teamId: team.id,
      role: MembershipRole.MEMBER,
      organizationId,
    });

    const user = await prismock.user.findUnique({ where: { id } });
    expect(user).toEqual(
      expect.objectContaining({ email: "invitee@example.com", username: null, organizationId })
    );
    const profile = await prismock.profile.findFirst({ where: { userId: id } });
    expect(profile).toBeNull();
  });

  test("createInvitedWithPendingTeamMembership leaves organizationId null when not given", async () => {
    const team = await prismock.team.create({ data: { name: "Plain Team", slug: "plain-team-invite" } });

    const { id } = await new UserRepository(prismock).createInvitedWithPendingTeamMembership({
      email: "plain-invitee@example.com",
      teamId: team.id,
      role: MembershipRole.MEMBER,
    });

    const user = await prismock.user.findUnique({ where: { id } });
    expect(user?.organizationId).toBeNull();
  });

  test("findInviteeByEmail returns organizationId and username", async () => {
    await new UserRepository(prismock).create({
      username: "org-member",
      email: "org-member@example.com",
      organizationId: 789,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });

    const invitee = await new UserRepository(prismock).findInviteeByEmail({
      email: "ORG-member@example.com",
    });

    expect(invitee).toEqual(
      expect.objectContaining({ username: "org-member", organizationId: 789, hasPassword: false })
    );
  });

  test("setOrganizationId updates the user row", async () => {
    const user = await new UserRepository(prismock).create({
      username: null,
      email: "no-org@example.com",
      organizationId: null,
      creationSource: CreationSource.WEBAPP,
      locked: false,
    });

    await new UserRepository(prismock).setOrganizationId({ id: user.id, organizationId: 321 });

    const updated = await prismock.user.findUnique({ where: { id: user.id } });
    expect(updated?.organizationId).toBe(321);
  });
});

describe("_getWhereClauseForFindingUsersByUsername", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("Should scope non-profile username matches to the organization with the given slug", async () => {
    const findManySpy = vi.spyOn(ProfileRepository, "findManyByOrgSlugOrRequestedSlug").mockResolvedValue([]);

    const { where } = await new UserRepository(prismock)._getWhereClauseForFindingUsersByUsername({
      orgSlug: "acme",
      usernameList: ["a"],
    });

    expect(findManySpy).toHaveBeenCalledWith({ orgSlug: "acme", usernames: ["a"] });
    expect(where).toEqual({ username: { in: ["a"] }, organization: { slug: "acme" } });
    findManySpy.mockRestore();
  });

  test("Should only match users outside any organization when no orgSlug is given", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    const findManySpy = vi.spyOn(ProfileRepository, "findManyByOrgSlugOrRequestedSlug");

    const { where } = await new UserRepository(prismock)._getWhereClauseForFindingUsersByUsername({
      orgSlug: null,
      usernameList: ["a"],
    });

    expect(findManySpy).not.toHaveBeenCalled();
    expect(where).toEqual({ username: { in: ["a"] }, organization: null });
    findManySpy.mockRestore();
  });

  test("ignores the organization when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const { where } = await new UserRepository(prismock)._getWhereClauseForFindingUsersByUsername({
      orgSlug: null,
      usernameList: ["a"],
    });

    // Users who sit inside an organization must still match by username while the flag is off.
    expect(where).toEqual({ username: { in: ["a"] } });
  });
});

describe("booking access lookups", () => {
  const findMany = vi.fn();
  const findUnique = vi.fn();
  const fakePrismaClient = { team: { findMany }, user: { findUnique } } as unknown as PrismaClient;
  const adminMembership = {
    members: { some: { userId: 1, role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] } } },
  };

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
    findUnique.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("isAdminOfTeamOrParentOrg accepts admins of the parent organization when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    findMany.mockResolvedValue([{ id: 5 }]);

    const isAdmin = await new UserRepository(fakePrismaClient).isAdminOfTeamOrParentOrg({
      userId: 1,
      teamId: 5,
    });

    expect(isAdmin).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: 5, OR: [adminMembership, { parent: adminMembership }] },
      select: { id: true },
    });
  });

  test("isAdminOfTeamOrParentOrg ignores the BlueBee parent when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    const isAdmin = await new UserRepository(fakePrismaClient).isAdminOfTeamOrParentOrg({
      userId: 1,
      teamId: 5,
    });

    expect(isAdmin).toBe(false);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: 5, OR: [adminMembership] },
      select: { id: true },
    });
  });

  test("getUserOrganizationAndTeams counts every accepted membership when organizations are enabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await new UserRepository(fakePrismaClient).getUserOrganizationAndTeams({ userId: 7 });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { organizationId: true, teams: { where: { accepted: true }, select: { teamId: true } } },
    });
  });

  test("getUserOrganizationAndTeams skips the BlueBee membership when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await new UserRepository(fakePrismaClient).getUserOrganizationAndTeams({ userId: 7 });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: {
        organizationId: true,
        teams: { where: { accepted: true, team: { isOrganization: false } }, select: { teamId: true } },
      },
    });
  });
});
