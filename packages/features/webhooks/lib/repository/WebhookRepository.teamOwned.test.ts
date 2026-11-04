import type { IEventTypesRepository } from "@calcom/features/eventtypes/eventtypes.repository.interface";
import type { IUsersRepository } from "@calcom/features/users/users.repository.interface";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const repository = new WebhookRepository(
  prismaMock as unknown as PrismaClient,
  {} as IEventTypesRepository,
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
    it("hides team-owned webhooks and their secret from a plain member", async () => {
      prismaMock.user.findUnique.mockResolvedValue(viewerWithRole(MembershipRole.MEMBER));

      const { webhookGroups } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const ids = webhookGroups.flatMap((group) => group.webhooks.map((webhook) => webhook.id));

      expect(ids).toEqual(["wh-team-user"]);
      expect(JSON.stringify(webhookGroups)).not.toContain("team-secret");
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
  });

  describe("listWebhooks", () => {
    beforeEach(() => {
      userRepository.findUserTeams.mockResolvedValue({ teams: [{ teamId: 3 }] });
      prismaMock.webhook.findMany.mockResolvedValue([]);
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

    it("keeps the existing user/team scope condition unchanged", async () => {
      prismaMock.membership.findMany.mockResolvedValue([]);

      await repository.listWebhooks({ userId: 7 });

      expect(whereConditions()).toContainEqual({ OR: [{ userId: 7 }, { teamId: { in: [3] } }] });
    });
  });
});
