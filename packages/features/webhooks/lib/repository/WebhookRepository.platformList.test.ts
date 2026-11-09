import type { IEventTypesRepository } from "@calcom/features/eventtypes/eventtypes.repository.interface";
import type { IUsersRepository } from "@calcom/features/users/users.repository.interface";
import type { PrismaClient } from "@calcom/prisma";
import { UserPermissionRole } from "@calcom/prisma/enums";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookRepository } from "./WebhookRepository";

const baseWebhook = {
  subscriberUrl: "https://platform.example.com/hook",
  payloadTemplate: null,
  appId: null,
  active: true,
  eventTriggers: [],
  eventTypeId: null,
  teamId: null,
  userId: null,
  time: null,
  timeUnit: null,
  version: "2021-10-20",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  platform: true,
  platformOAuthClientId: null,
  includeMemberMeetings: false,
};

const platformWebhook = { ...baseWebhook, id: "wh-platform", secret: "platform-secret" };
const platformTeamWebhook = {
  ...baseWebhook,
  id: "wh-platform-team",
  teamId: 9,
  secret: "platform-team-secret",
};
const platformAppWebhook = {
  ...baseWebhook,
  id: "wh-platform-app",
  appId: "acme",
  secret: "platform-app-secret",
};

const prismaMock = {
  user: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  webhook: { findMany: vi.fn() },
};

const userRepository = { findUserTeams: vi.fn() };
const eventTypeRepository = { findParentEventTypeId: vi.fn(), findByIdWithUserIdAndTeamId: vi.fn() };

const repository = new WebhookRepository(
  prismaMock as unknown as PrismaClient,
  eventTypeRepository as unknown as IEventTypesRepository,
  userRepository as unknown as IUsersRepository
);

const adminUser = () => ({
  id: 7,
  username: "admin",
  name: "Admin",
  avatarUrl: null,
  webhooks: [],
  teams: [],
});

describe("WebhookRepository platform webhook visibility (T562)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.membership.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const whereConditions = (call = 0) => prismaMock.webhook.findMany.mock.calls[call][0].where.AND;

  const platformScopes = () =>
    whereConditions().filter((condition: { OR?: unknown[] }) =>
      (condition.OR ?? []).some(
        (branch) => typeof branch === "object" && branch !== null && "platform" in branch
      )
    );

  describe("listWebhooks", () => {
    it.each([
      "",
      "1",
    ])("shows platform webhooks to an instance admin with ORGANIZATIONS_ENABLED=%s", async (flag) => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", flag);
      prismaMock.webhook.findMany.mockResolvedValue([platformWebhook]);

      const webhooks = await repository.listWebhooks({ userId: 7, userRole: UserPermissionRole.ADMIN });

      expect(webhooks.map((webhook) => webhook.id)).toEqual(["wh-platform"]);
      expect(webhooks[0].secret).toBe("platform-secret");
      // Both the ownership scope and the shape scope admit platform webhooks for admins.
      expect(platformScopes()).toHaveLength(2);
    });

    it("hides platform webhooks when no role is passed (fail closed for direct repository callers)", async () => {
      prismaMock.webhook.findMany.mockResolvedValue([]);

      await repository.listWebhooks({ userId: 7 });

      expect(JSON.stringify(whereConditions())).not.toContain('"platform":true');
      expect(prismaMock.webhook.findMany).toHaveBeenCalled();
    });

    it("hides platform webhooks from non-admin viewers", async () => {
      prismaMock.webhook.findMany.mockResolvedValue([]);

      await repository.listWebhooks({ userId: 7, userRole: UserPermissionRole.USER });

      expect(JSON.stringify(whereConditions())).not.toContain('"platform":true');
    });

    it("shows platform webhooks attached to a team the admin does not administer", async () => {
      // create.handler allows platform webhooks to carry a teamId, so the platform scope
      // must not depend on team membership; admins manage these rows via edit/delete already.
      prismaMock.webhook.findMany.mockResolvedValue([platformTeamWebhook]);

      const webhooks = await repository.listWebhooks({ userId: 7, userRole: UserPermissionRole.ADMIN });

      expect(webhooks.map((webhook) => webhook.id)).toEqual(["wh-platform-team"]);
      expect(platformScopes()).toHaveLength(2);
    });

    it("keeps the appId scope on platform webhooks (residual difference to getByViewer)", async () => {
      // list is appId-scoped by design while getByViewer's platform group is unfiltered;
      // a platform webhook with a non-null appId only surfaces when that appId is requested.
      prismaMock.webhook.findMany.mockResolvedValue([platformAppWebhook]);

      await repository.listWebhooks({ userId: 7, userRole: UserPermissionRole.ADMIN });
      expect(whereConditions()).toContainEqual({ appId: null });

      const webhooks = await repository.listWebhooks({
        userId: 7,
        userRole: UserPermissionRole.ADMIN,
        appId: "acme",
      });
      expect(whereConditions(1)).toContainEqual({ appId: "acme" });
      expect(webhooks.map((webhook) => webhook.id)).toEqual(["wh-platform-app"]);
    });

    it("builds the same admin where clause with ORGANIZATIONS_ENABLED on and off", async () => {
      await repository.listWebhooks({ userId: 7, userRole: UserPermissionRole.ADMIN });
      const flagOffWhere = prismaMock.webhook.findMany.mock.calls[0][0].where;

      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      await repository.listWebhooks({ userId: 7, userRole: UserPermissionRole.ADMIN });
      const flagOnWhere = prismaMock.webhook.findMany.mock.calls[1][0].where;

      expect(flagOnWhere).toEqual(flagOffWhere);
    });
  });

  describe("getFilteredWebhooksForUser platform parity", () => {
    it("shows platform webhooks to an instance admin", async () => {
      prismaMock.user.findUnique.mockResolvedValue(adminUser());
      prismaMock.webhook.findMany.mockResolvedValue([platformWebhook]);

      const { webhookGroups } = await repository.getFilteredWebhooksForUser({
        userId: 7,
        userRole: UserPermissionRole.ADMIN,
      });
      const ids = webhookGroups.flatMap((group) => group.webhooks.map((webhook) => webhook.id));

      expect(ids).toContain("wh-platform");
    });

    it("shows no platform webhooks to a non-admin and never queries them", async () => {
      prismaMock.user.findUnique.mockResolvedValue(adminUser());

      const { webhookGroups } = await repository.getFilteredWebhooksForUser({ userId: 7 });
      const ids = webhookGroups.flatMap((group) => group.webhooks.map((webhook) => webhook.id));

      expect(ids).not.toContain("wh-platform");
      expect(prismaMock.webhook.findMany).not.toHaveBeenCalled();
    });
  });
});
