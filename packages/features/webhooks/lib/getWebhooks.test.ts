import type { PrismaClient } from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import getWebhooks from "./getWebhooks";

function createPrisma() {
  const findMany = vi.fn().mockResolvedValue([]);
  const findFirst = vi.fn().mockResolvedValue(null);
  const prisma = { webhook: { findMany }, eventType: { findFirst } } as unknown as PrismaClient;
  return { prisma, findMany };
}

type WebhookWhere = { OR: Record<string, unknown>[]; AND: Record<string, unknown> };

function whereOf(findMany: ReturnType<typeof vi.fn>): WebhookWhere {
  return findMany.mock.calls[0][0].where as WebhookWhere;
}

const baseOptions = {
  userId: 1,
  eventTypeId: null,
  teamId: null,
  orgId: null,
  oAuthClientId: null,
  triggerEvent: WebhookTriggerEvents.RECORDING_TRANSCRIPTION_GENERATED,
};

describe("getWebhooks", () => {
  it("adds no member meetings branch when memberSharingTeamIds is not given", async () => {
    const { prisma, findMany } = createPrisma();
    await getWebhooks(baseOptions, prisma);
    const where = whereOf(findMany);
    expect(where.OR).toHaveLength(6);
    expect(JSON.stringify(where.OR)).not.toContain("includeMemberMeetings");
  });

  it("adds no member meetings branch for an empty memberSharingTeamIds", async () => {
    const { prisma, findMany } = createPrisma();
    await getWebhooks({ ...baseOptions, memberSharingTeamIds: [] }, prisma);
    expect(whereOf(findMany).OR).toHaveLength(6);
  });

  it("matches opted-in webhooks of the member sharing teams under the same trigger and active filters", async () => {
    const { prisma, findMany } = createPrisma();
    await getWebhooks({ ...baseOptions, memberSharingTeamIds: [20, 30] }, prisma);
    const where = whereOf(findMany);
    expect(where.OR).toHaveLength(7);
    expect(where.OR).toContainEqual({ teamId: { in: [20, 30] }, includeMemberMeetings: true });
    expect(where.AND).toEqual({
      eventTriggers: { has: WebhookTriggerEvents.RECORDING_TRANSCRIPTION_GENERATED },
      active: { equals: true },
    });
  });
});
