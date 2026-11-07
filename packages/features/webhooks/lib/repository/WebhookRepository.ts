import type { IEventTypesRepository } from "@calcom/features/eventtypes/eventtypes.repository.interface";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { UsersRepository } from "@calcom/features/users/users.repository";
import type { IUsersRepository } from "@calcom/features/users/users.repository.interface";
import { getPlaceholderAvatar } from "@calcom/lib/defaultAvatarImage";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import type { PrismaClient } from "@calcom/prisma";
import { prisma as defaultPrisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { TimeUnit, WebhookTriggerEvents } from "@calcom/prisma/enums";
import { MembershipRole, UserPermissionRole } from "@calcom/prisma/enums";
import type { Webhook, WebhookGroup, WebhookSubscriber } from "../dto/types";
import { WebhookOutputMapper } from "../infrastructure/mappers/WebhookOutputMapper";
import type {
  IWebhookRepository,
  ListWebhooksOptions,
  WebhookVersion,
} from "../interface/IWebhookRepository";
import { parseWebhookVersion } from "../interface/IWebhookRepository";
import type { GetSubscribersOptions } from "./types";

// Type for raw query results from the database
interface WebhookQueryResult {
  id: string;
  subscriberUrl: string;
  payloadTemplate: string | null;
  appId: string | null;
  secret: string | null;
  time: number | null;
  timeUnit: TimeUnit | null;
  eventTriggers: WebhookTriggerEvents[];
  version: WebhookVersion;
  priority: number; // This field is added by the query and removed before returning
}

const isTeamAdminRole = (role: MembershipRole): boolean =>
  role === MembershipRole.ADMIN || role === MembershipRole.OWNER;

// Member-meeting webhooks have no owning user (userId null), so only team admins/owners may see them.
const isTeamOwnedWebhook = (webhook: {
  userId: number | null;
  teamId: number | null;
  eventTypeId: number | null;
}): boolean => webhook.userId == null && webhook.teamId != null && webhook.eventTypeId == null;

const filterWebhooks = (webhook: { appId: string | null }): boolean => {
  const appIds = [
    "zapier",
    "make",
    // Add more if needed
  ];

  return !appIds.some((appId: string) => webhook.appId === appId);
};

export class WebhookRepository implements IWebhookRepository {
  private static _instance: WebhookRepository | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventTypeRepository: IEventTypesRepository,
    _userRepository: IUsersRepository
  ) {}

  /**
   *
   * @deprecated Use DI container instead:
   * ```typescript
   * import { getWebhookFeature } from "@calcom/features/di/webhooks/containers/webhook";
   * const { repository } = getWebhookFeature();
   * ```
   *
   */
  static getInstance(): WebhookRepository {
    if (!WebhookRepository._instance) {
      WebhookRepository._instance = new WebhookRepository(
        defaultPrisma,
        new EventTypeRepository(defaultPrisma),
        new UsersRepository()
      );
    }
    return WebhookRepository._instance;
  }

  async getSubscribers(options: GetSubscribersOptions): Promise<WebhookSubscriber[]> {
    const teamId = options.teamId;
    const userId = options.userId;
    const eventTypeId = options.eventTypeId;
    const teamIds = Array.isArray(teamId) ? teamId : teamId ? [teamId] : undefined;
    const orgId = options.orgId;
    const oAuthClientId = options.oAuthClientId;

    let managedParentEventTypeId: number | undefined;
    if (eventTypeId) {
      managedParentEventTypeId =
        (await this.eventTypeRepository.findParentEventTypeId(eventTypeId)) ?? undefined;
    }

    const webhooks = await this.getSubscribersRaw({
      userId,
      eventTypeId,
      managedParentEventTypeId,
      teamIds: teamIds && orgId ? [...teamIds, orgId] : teamIds || (orgId ? [orgId] : undefined),
      oAuthClientId,
      memberSharingTeamIds: options.memberSharingTeamIds?.length ? options.memberSharingTeamIds : undefined,
      triggerEvent: options.triggerEvent,
    });

    return webhooks.map((webhook) => ({
      id: webhook.id,
      subscriberUrl: webhook.subscriberUrl,
      payloadTemplate: webhook.payloadTemplate,
      appId: webhook.appId,
      secret: webhook.secret,
      time: webhook.time,
      timeUnit: webhook.timeUnit as TimeUnit | null,
      eventTriggers: webhook.eventTriggers as WebhookTriggerEvents[],
      version: webhook.version,
    }));
  }

  /**
   * Raw SQL query using UNION for better index utilization than complex ORs
   * Each UNION branch can use its own optimal index
   */
  private async getSubscribersRaw(params: {
    userId?: number | null;
    eventTypeId?: number | null;
    managedParentEventTypeId?: number | null;
    teamIds?: number[];
    oAuthClientId?: string | null;
    memberSharingTeamIds?: number[];
    triggerEvent: WebhookTriggerEvents;
  }): Promise<WebhookSubscriber[]> {
    const {
      userId,
      eventTypeId,
      managedParentEventTypeId,
      teamIds,
      oAuthClientId,
      memberSharingTeamIds,
      triggerEvent,
    } = params;

    // IMPORTANT: Explicit type casts (::int, ::text) are required for nullable params
    // PostgreSQL can't infer types for NULL values without explicit casts
    const results = await this.prisma.$queryRaw<WebhookQueryResult[]>`
      -- Platform webhooks (highest priority)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        1 as priority
      FROM "Webhook"
      WHERE active = true 
        AND platform = true 
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
      
      UNION ALL
      
      -- User-specific webhooks (only if userId provided)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        2 as priority
      FROM "Webhook"
      WHERE active = true 
        AND ${userId}::int IS NOT NULL
        AND "userId" = ${userId}::int
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
        AND platform = false
      
      UNION ALL
      
      -- Event type webhooks (only if eventTypeId provided)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        3 as priority
      FROM "Webhook"
      WHERE active = true 
        AND ${eventTypeId}::int IS NOT NULL
        AND "eventTypeId" = ${eventTypeId}::int
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
        AND platform = false
      
      UNION ALL
      
      -- Parent event type webhooks (only if managedParentEventTypeId provided)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        4 as priority
      FROM "Webhook"
      WHERE active = true 
        AND ${managedParentEventTypeId}::int IS NOT NULL
        AND "eventTypeId" = ${managedParentEventTypeId}::int
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
        AND platform = false
      
      UNION ALL
      
      -- Team webhooks (only if teamIds provided and not empty)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        5 as priority
      FROM "Webhook"
      WHERE active = true 
        AND ${teamIds}::int[] IS NOT NULL
        AND cardinality(${teamIds}::int[]) > 0
        AND "teamId" = ANY(${teamIds}::int[])
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
        AND platform = false
      
      UNION ALL
      
      -- OAuth client webhooks (only if oAuthClientId provided)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        6 as priority
      FROM "Webhook"
      WHERE active = true 
        AND ${oAuthClientId}::text IS NOT NULL
        AND "platformOAuthClientId" = ${oAuthClientId}::text
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
        AND platform = false
      
      UNION ALL
      
      -- Team webhooks opted into member meetings (only if memberSharingTeamIds provided and not empty)
      SELECT 
        id, "subscriberUrl", "payloadTemplate", "appId", secret, time, "timeUnit", "eventTriggers", version,
        7 as priority
      FROM "Webhook"
      WHERE active = true 
        AND ${memberSharingTeamIds}::int[] IS NOT NULL
        AND cardinality(${memberSharingTeamIds}::int[]) > 0
        AND "teamId" = ANY(${memberSharingTeamIds}::int[])
        AND "includeMemberMeetings" = true
        AND ${triggerEvent}::"WebhookTriggerEvents" = ANY("eventTriggers")
        AND platform = false
      
      ORDER BY priority, id
    `;

    const uniqueWebhooks = new Map<string, WebhookSubscriber>();
    for (const webhook of results) {
      if (!uniqueWebhooks.has(webhook.id)) {
        const { priority: _priority, ...webhookData } = webhook;
        uniqueWebhooks.set(webhook.id, webhookData);
      }
    }

    return Array.from(uniqueWebhooks.values());
  }

  async getWebhookById(id: string): Promise<WebhookSubscriber | null> {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id },
      select: {
        id: true,
        subscriberUrl: true,
        payloadTemplate: true,
        appId: true,
        secret: true,
        time: true,
        timeUnit: true,
        eventTriggers: true,
        version: true,
      },
    });

    if (!webhook) return null;

    return {
      id: webhook.id,
      subscriberUrl: webhook.subscriberUrl,
      payloadTemplate: webhook.payloadTemplate,
      appId: webhook.appId,
      secret: webhook.secret,
      time: webhook.time,
      timeUnit: webhook.timeUnit as TimeUnit | null,
      eventTriggers: webhook.eventTriggers,
      version: parseWebhookVersion(webhook.version),
    };
  }

  async findByWebhookId(webhookId?: string) {
    const webhook = await this.prisma.webhook.findUniqueOrThrow({
      where: {
        id: webhookId,
      },
      select: {
        id: true,
        subscriberUrl: true,
        payloadTemplate: true,
        active: true,
        eventTriggers: true,
        secret: true,
        teamId: true,
        userId: true,
        platform: true,
        time: true,
        timeUnit: true,
        version: true,
        includeMemberMeetings: true,
      },
    });

    return {
      ...webhook,
      version: parseWebhookVersion(webhook.version),
    };
  }

  async findByOrgIdAndTrigger({
    orgId,
    triggerEvent,
  }: {
    orgId: number;
    triggerEvent: WebhookTriggerEvents;
  }): Promise<WebhookSubscriber[]> {
    const webhooks = await this.prisma.webhook.findMany({
      where: {
        teamId: orgId,
        platform: false,
        eventTriggers: { has: triggerEvent },
        active: true,
      },
      select: {
        id: true,
        subscriberUrl: true,
        payloadTemplate: true,
        active: true,
        eventTriggers: true,
        secret: true,
        teamId: true,
        userId: true,
        platform: true,
        time: true,
        timeUnit: true,
        appId: true,
        version: true,
      },
    });
    return webhooks.map((webhook) => ({
      ...webhook,
      eventTriggers: webhook.eventTriggers as WebhookTriggerEvents[],
      version: parseWebhookVersion(webhook.version),
    }));
  }

  async getFilteredWebhooksForUser({ userId, userRole }: { userId: number; userRole?: UserPermissionRole }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        webhooks: {
          select: {
            id: true,
            subscriberUrl: true,
            payloadTemplate: true,
            appId: true,
            secret: true,
            active: true,
            eventTriggers: true,
            eventTypeId: true,
            teamId: true,
            userId: true,
            time: true,
            timeUnit: true,
            version: true,
            createdAt: true,
            platform: true,
            platformOAuthClientId: true,
            includeMemberMeetings: true,
          },
        },
        teams: {
          where: {
            accepted: true,
          },
          select: {
            role: true,
            team: {
              select: {
                id: true,
                name: true,
                slug: true,
                logoUrl: true,
                webhooks: {
                  select: {
                    id: true,
                    subscriberUrl: true,
                    payloadTemplate: true,
                    appId: true,
                    secret: true,
                    active: true,
                    eventTriggers: true,
                    eventTypeId: true,
                    teamId: true,
                    userId: true,
                    time: true,
                    timeUnit: true,
                    version: true,
                    createdAt: true,
                    platform: true,
                    platformOAuthClientId: true,
                    includeMemberMeetings: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const webhookGroups: WebhookGroup[] = [];

    // Add user's personal webhooks
    webhookGroups.push({
      teamId: null,
      profile: {
        slug: user.username,
        name: user.name,
        image: getUserAvatarUrl({ avatarUrl: user.avatarUrl }),
      },
      webhooks: WebhookOutputMapper.toWebhookList(user.webhooks.filter(filterWebhooks)),
      metadata: {
        canModify: true,
        canDelete: true,
      },
    });

    // Mirrors the server guards (assertCanManageTeamWebhooks): only accepted direct ADMIN/OWNER members manage team webhooks.
    for (const membership of user.teams) {
      const canManage = isTeamAdminRole(membership.role);

      webhookGroups.push({
        teamId: membership.team.id,
        profile: {
          name: membership.team.name,
          slug: membership.team.slug || null,
          image: getPlaceholderAvatar(membership.team.logoUrl, membership.team.name),
        },
        webhooks: WebhookOutputMapper.toWebhookList(
          membership.team.webhooks
            .filter(filterWebhooks)
            .filter((webhook) => isTeamAdminRole(membership.role) || !isTeamOwnedWebhook(webhook))
        ),
        metadata: {
          canModify: canManage,
          canDelete: canManage,
        },
      });
    }

    // Add platform webhooks for admins
    if (userRole === UserPermissionRole.ADMIN) {
      const platformWebhooks = await this.prisma.webhook.findMany({
        where: { platform: true },
        select: {
          id: true,
          subscriberUrl: true,
          payloadTemplate: true,
          appId: true,
          secret: true,
          active: true,
          eventTriggers: true,
          eventTypeId: true,
          teamId: true,
          userId: true,
          time: true,
          timeUnit: true,
          version: true,
          createdAt: true,
          platform: true,
          platformOAuthClientId: true,
          includeMemberMeetings: true,
        },
      });

      webhookGroups.push({
        teamId: null,
        profile: {
          slug: "Platform",
          name: "Platform",
          image: getPlaceholderAvatar(null, "Platform"),
        },
        webhooks: WebhookOutputMapper.toWebhookList(platformWebhooks),
        metadata: {
          canDelete: true,
          canModify: true,
        },
      });
    }

    return {
      webhookGroups: webhookGroups.filter((group) => group.webhooks.length > 0),
      profiles: webhookGroups.map((group) => ({
        teamId: group.teamId,
        ...group.profile,
        ...group.metadata,
      })),
    };
  }

  /**
   * List webhooks for a user with filtering options.
   * Handles:
   * - App filtering (excludes zapier/make by default unless appId specified)
   * - Event type filtering (with managed event type parent handling)
   * - Event trigger filtering
   * - Team filtering to teams the user administers
   */
  async listWebhooks(options: ListWebhooksOptions): Promise<Webhook[]> {
    const { userId, appId, eventTypeId, eventTriggers } = options;

    // Build WHERE conditions
    const whereConditions: NonNullable<Prisma.WebhookWhereInput["AND"]> = [
      // AppId filter - null appId by default (excludes zapier/make)
      { appId: appId ?? null },
    ];

    if (eventTypeId) {
      const managedParentId = await this.eventTypeRepository.findParentEventTypeId(eventTypeId);

      if (managedParentId) {
        // Include webhooks from both the event type and its parent (if active)
        whereConditions.push({
          OR: [{ eventTypeId }, { eventTypeId: managedParentId, active: true }],
        });
      } else {
        whereConditions.push({ eventTypeId });
      }
    } else {
      // Team webhooks expose their secret, so only teams the viewer administers (accepted ADMIN/OWNER) are in scope.
      const adminTeamIds = (
        await this.prisma.membership.findMany({
          where: {
            userId,
            accepted: true,
            role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] },
          },
          select: { teamId: true },
        })
      ).map((membership) => membership.teamId);

      whereConditions.push({
        OR: [{ userId }, ...(adminTeamIds.length ? [{ teamId: { in: adminTeamIds } }] : [])],
      });

      whereConditions.push({
        OR: [
          { userId: { not: null } },
          { teamId: null },
          { eventTypeId: { not: null } },
          ...(adminTeamIds.length ? [{ teamId: { in: adminTeamIds } }] : []),
        ],
      });
    }

    // Event triggers filter
    if (eventTriggers?.length) {
      whereConditions.push({ eventTriggers: { hasEvery: eventTriggers } });
    }

    const webhooks = await this.prisma.webhook.findMany({
      where: { AND: whereConditions },
      select: {
        id: true,
        subscriberUrl: true,
        payloadTemplate: true,
        appId: true,
        secret: true,
        active: true,
        eventTriggers: true,
        eventTypeId: true,
        teamId: true,
        userId: true,
        time: true,
        timeUnit: true,
        version: true,
        createdAt: true,
        platform: true,
        platformOAuthClientId: true,
        includeMemberMeetings: true,
      },
    });

    return WebhookOutputMapper.toWebhookList(webhooks);
  }
}
