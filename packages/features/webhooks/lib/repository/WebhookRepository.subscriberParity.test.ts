import type { IEventTypesRepository } from "@calcom/features/eventtypes/eventtypes.repository.interface";
import type { IUsersRepository } from "@calcom/features/users/users.repository.interface";
import type { PrismaClient } from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import getWebhooks from "../getWebhooks";
import { WebhookRepository } from "./WebhookRepository";

const legacyPrismaMock = {
  eventType: { findFirst: vi.fn() },
  webhook: { findMany: vi.fn() },
};

const queryRaw = vi.fn();
const eventTypeRepository = {
  findParentEventTypeId: vi.fn(),
  findByIdWithUserIdAndTeamId: vi.fn(),
};

const repository = new WebhookRepository(
  { $queryRaw: queryRaw } as unknown as PrismaClient,
  eventTypeRepository as unknown as IEventTypesRepository,
  {} as IUsersRepository
);

const baseOptions = {
  userId: 5,
  eventTypeId: 11,
  triggerEvent: WebhookTriggerEvents.BOOKING_CREATED,
};

/** Effective team scope of the legacy path: `teamId in [...teamIds, orgId]` minus the 0-fillers. */
const legacyTeamScope = () => {
  const where = legacyPrismaMock.webhook.findMany.mock.calls[0][0].where;
  const entry = where.OR.find((condition: { teamId?: { in?: number[] } }) =>
    Array.isArray(condition?.teamId?.in)
  );
  expect(entry).toBeDefined();
  return (entry.teamId.in as number[]).filter((id) => id !== 0).sort((a, b) => a - b);
};

/** Effective team scope of the repository path: the teamIds array interpolated into the raw SQL. */
const repositoryTeamScope = () => {
  const [, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const arrays = values.filter((value): value is number[] => Array.isArray(value));
  const scope = arrays.length ? arrays[0] : [];
  return [...scope].sort((a, b) => a - b);
};

describe("WebhookRepository subscriber org-scoping parity (T563)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    legacyPrismaMock.eventType.findFirst.mockResolvedValue(null);
    legacyPrismaMock.webhook.findMany.mockResolvedValue([]);
    eventTypeRepository.findParentEventTypeId.mockResolvedValue(null);
    queryRaw.mockResolvedValue([]);
  });

  it.each([
    { teamId: undefined, orgId: undefined },
    { teamId: null, orgId: null },
    { teamId: null, orgId: 9 },
    { teamId: undefined, orgId: 9 },
    { teamId: 3, orgId: undefined },
    { teamId: 3, orgId: null },
    { teamId: 3, orgId: 9 },
    { teamId: [3, 4], orgId: 9 },
    { teamId: [3, 4], orgId: undefined },
    { teamId: [], orgId: 9 },
  ])("scopes team webhooks identically for teamId=$teamId orgId=$orgId", async ({ teamId, orgId }) => {
    await getWebhooks(
      { ...baseOptions, teamId: teamId ?? undefined, orgId: orgId ?? undefined },
      legacyPrismaMock as unknown as PrismaClient
    );
    await repository.getSubscribers({
      ...baseOptions,
      teamId: teamId ?? undefined,
      orgId: orgId ?? undefined,
    });

    // No caller can see another org's webhooks through one path but not the other:
    // both reduce to the same effective team-id set.
    expect(repositoryTeamScope()).toEqual(legacyTeamScope());
  });

  it("resolves the managed parent event identically on both paths", async () => {
    legacyPrismaMock.eventType.findFirst.mockResolvedValue({ parentId: 5 });
    eventTypeRepository.findParentEventTypeId.mockResolvedValue(5);

    await getWebhooks({ ...baseOptions }, legacyPrismaMock as unknown as PrismaClient);
    await repository.getSubscribers({ ...baseOptions });

    const legacyWhere = legacyPrismaMock.webhook.findMany.mock.calls[0][0].where;
    expect(legacyWhere.OR).toContainEqual({ eventTypeId: 5 });
    const [, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).toContain(5);
  });

  it("matches nothing on both paths when the event type has no managed parent", async () => {
    await getWebhooks({ ...baseOptions }, legacyPrismaMock as unknown as PrismaClient);
    await repository.getSubscribers({ ...baseOptions });

    // The legacy path coerces the absent parent to 0 and the repository path skips the branch;
    // event-type ids start at 1, so both match no parent row.
    const legacyWhere = legacyPrismaMock.webhook.findMany.mock.calls[0][0].where;
    expect(legacyWhere.OR).toContainEqual({ eventTypeId: 0 });
    const [, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).not.toContain(0);
  });

  it("documents the absent-id coercions as matching nothing on both paths", async () => {
    await getWebhooks(
      { triggerEvent: WebhookTriggerEvents.BOOKING_CREATED },
      legacyPrismaMock as unknown as PrismaClient
    );
    await repository.getSubscribers({ triggerEvent: WebhookTriggerEvents.BOOKING_CREATED });

    // The legacy path coerces absent ids to 0 (`userId ?? 0`, `eventTypeId ?? 0`) while the
    // repository path skips those branches via IS NOT NULL guards. Ids start at 1, and
    // platformOAuthClientId is a foreign key (never ""), so neither form matches a real row.
    const legacyWhere = legacyPrismaMock.webhook.findMany.mock.calls[0][0].where;
    expect(legacyWhere.OR).toContainEqual({ userId: 0 });
    expect(legacyWhere.OR).toContainEqual({ platformOAuthClientId: "" });
    const [, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).not.toContain(0);
    expect(values).not.toContain("");
  });
});
