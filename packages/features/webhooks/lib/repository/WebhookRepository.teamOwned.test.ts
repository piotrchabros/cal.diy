import type { IEventTypesRepository } from "@calcom/features/eventtypes/eventtypes.repository.interface";
import type { IUsersRepository } from "@calcom/features/users/users.repository.interface";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookRepository } from "./WebhookRepository";

const baseWebhook = {
  subscriberUrl: "https://crm.example.com/hook",
  payloadTemplate: null,
  appId: null,
  active: true,
  eventTriggers: [],
  eventTypeId: null,
  time: null,
  timeUnit: null,
  version: "2021-10-20",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  platform: false,
  platformOAuthClientId: null,
  includeMemberMeetings: false,
};

const teamOwned = {
  ...baseWebhook,
  id: "wh-team",
  teamId: 3,
  userId: null,
  secret: "team-secret",
  includeMemberMeetings: true,
};
const teamUserOwned = { ...baseWebhook, id: "wh-team-user", teamId: 3, userId: 99, secret: "user-secret" };

const prismaMock = {
  user: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  webhook: { findMany: vi.fn() },
};

const userRepository = { findUserTeams: vi.fn() };
const eventTypeRepository = { findParentEventTypeId: vi.fn() };

const repository = new WebhookRepository(
  prismaMock as unknown as PrismaClient,
  eventTypeRepository as unknown as IEventTypesRepository,
  userRepository as unknown as IUsersRepository
);

const viewerWithRole = (role: MembershipRole) => ({
  id: 7,
  username: "viewer",
  name: "Viewer",
  avatarUrl: null,
  webhooks: [],
  teams: [
    {
      role,
      team: { id: 3, name: "Team", slug: "team", logoUrl: null, webhooks: [teamOwned, teamUserOwned] },
    },
  ],
});

describe("WebhookRepository team-owned webhook visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getFilteredWebhooksForUser", () => {
    it("hides every team webhook and its secret from a plain member, matching listWebhooks", async () => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(MembershipRole.MEMBER));

      const { webhookGroups } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const ids = webhookGroups.flatMap((group) => group.webhooks.map((webhook) => webhook.id));

      expect(ids).toEqual([]);
      expect(JSON.stringify(webhookGroups)).not.toContain("team-secret");
      expect(JSON.stringify(webhookGroups)).not.toContain("user-secret");
    });

    it("keeps the team profile for a plain member so the team still appears without webhooks", async () => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(MembershipRole.MEMBER));

      const { webhookGroups, profiles } = await repository.getFilteredWebhooksForUser({ userId: 7 });

      expect(webhookGroups.find((group) => group.teamId === 3)).toBeUndefined();
      expect(profiles.find((profile) => profile.teamId === 3)).toMatchObject({ slug: "team" });
    });

    it("still shows the viewer's own personal webhooks to a plain member", async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...viewerWithRole(MembershipRole.MEMBER),
        webhooks: [{ ...baseWebhook, id: "wh-own", teamId: null, userId: 7, secret: "own-secret" }],
      });

      const { webhookGroups } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const ids = webhookGroups.flatMap((group) => group.webhooks.map((webhook) => webhook.id));

      expect(ids).toEqual(["wh-own"]);
    });

    it("only reads accepted memberships", async () => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(MembershipRole.ADMIN));

      await repository.getFilteredWebhooksForUser({ userId: 7 });

      expect(prismaMock.user.findUnique.mock.calls[0][0].select.teams.where).toEqual({ accepted: true });
    });

    it.each([
      MembershipRole.ADMIN,
      MembershipRole.OWNER,
    ])("shows team-owned webhooks to a team %s", async (role) => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(role));

      const { webhookGroups } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const ids = webhookGroups.flatMap((group) => group.webhooks.map((webhook) => webhook.id));

      expect(ids).toEqual(["wh-team", "wh-team-user"]);
    });

    it("does not let a plain member modify or delete team webhooks", async () => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(MembershipRole.MEMBER));

      const { profiles } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const teamProfile = profiles.find((profile) => profile.teamId === 3);

      expect(teamProfile).toMatchObject({ canModify: false, canDelete: false });
    });

    it.each([
      MembershipRole.ADMIN,
      MembershipRole.OWNER,
    ])("lets a team %s modify and delete team webhooks", async (role) => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(role));

      const { webhookGroups, profiles } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const teamGroup = webhookGroups.find((group) => group.teamId === 3);
      const teamProfile = profiles.find((profile) => profile.teamId === 3);

      expect(teamGroup?.metadata).toEqual({ canModify: true, canDelete: true });
      expect(teamProfile).toMatchObject({ canModify: true, canDelete: true });
    });

    it.each([
      MembershipRole.MEMBER,
      MembershipRole.ADMIN,
      MembershipRole.OWNER,
    ])("always lets the viewer manage personal webhooks (team %s)", async (role) => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(role));

      const { profiles } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const personalProfile = profiles.find((profile) => profile.teamId === null);

      expect(personalProfile).toMatchObject({ slug: "viewer", canModify: true, canDelete: true });
    });
  });

  describe("listWebhooks", () => {
    beforeEach(() => {
      userRepository.findUserTeams.mockResolvedValue({ teams: [{ teamId: 3 }] });
      prismaMock.webhook.findMany.mockResolvedValue([]);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const whereConditions = () => prismaMock.webhook.findMany.mock.calls[0][0].where.AND;

    it("excludes team-owned webhooks for a viewer who administers no team", async () => {
      prismaMock.membership.findMany.mockResolvedValue([]);

      await repository.listWebhooks({ userId: 7 });

      expect(prismaMock.membership.findMany).toHaveBeenCalledWith({
        where: {
          userId: 7,
          accepted: true,
          role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] },
        },
        select: { teamId: true },
      });
      expect(whereConditions()).toContainEqual({
        OR: [{ userId: { not: null } }, { teamId: null }, { eventTypeId: { not: null } }],
      });
    });

    it("includes team-owned webhooks of teams the viewer administers", async () => {
      prismaMock.membership.findMany.mockResolvedValue([{ teamId: 3 }]);

      await repository.listWebhooks({ userId: 7 });

      expect(whereConditions()).toContainEqual({
        OR: [
          { userId: { not: null } },
          { teamId: null },
          { eventTypeId: { not: null } },
          { teamId: { in: [3] } },
        ],
      });
    });

    it("scopes to the viewer's own webhooks when they administer no team", async () => {
      prismaMock.membership.findMany.mockResolvedValue([]);

      await repository.listWebhooks({ userId: 7 });

      expect(whereConditions()).toContainEqual({ OR: [{ userId: 7 }] });
    });

    it("scopes team webhooks to teams the viewer administers", async () => {
      prismaMock.membership.findMany.mockResolvedValue([{ teamId: 3 }]);

      await repository.listWebhooks({ userId: 7 });

      expect(whereConditions()).toContainEqual({ OR: [{ userId: 7 }, { teamId: { in: [3] } }] });
    });

    it("does not derive team scope from all (including pending) memberships", async () => {
      prismaMock.membership.findMany.mockResolvedValue([]);

      await repository.listWebhooks({ userId: 7 });

      expect(userRepository.findUserTeams).not.toHaveBeenCalled();
      expect(JSON.stringify(whereConditions())).not.toContain('"teamId":{"in":[3]}');
    });

    it("filters by event type without querying memberships", async () => {
      eventTypeRepository.findParentEventTypeId.mockResolvedValue(null);

      await repository.listWebhooks({ userId: 7, eventTypeId: 11 });

      expect(prismaMock.membership.findMany).not.toHaveBeenCalled();
      expect(whereConditions()).toContainEqual({ eventTypeId: 11 });
    });

    it("builds the same where clause with ORGANIZATIONS_ENABLED on", async () => {
      prismaMock.membership.findMany.mockResolvedValue([{ teamId: 3 }]);
      await repository.listWebhooks({ userId: 7 });
      const flagOffWhere = prismaMock.webhook.findMany.mock.calls[0][0].where;

      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      await repository.listWebhooks({ userId: 7 });
      const flagOnWhere = prismaMock.webhook.findMany.mock.calls[1][0].where;

      expect(flagOnWhere).toEqual(flagOffWhere);
    });
  });
});
