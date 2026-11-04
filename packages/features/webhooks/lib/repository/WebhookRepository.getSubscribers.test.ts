import type { IEventTypesRepository } from "@calcom/features/eventtypes/eventtypes.repository.interface";
import type { IUsersRepository } from "@calcom/features/users/users.repository.interface";
import type { PrismaClient } from "@calcom/prisma";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import { WebhookRepository } from "./WebhookRepository";

function row(id: string, priority: number) {
  return {
    id,
    subscriberUrl: `https://crm.example/${id}`,
    payloadTemplate: null,
    appId: null,
    secret: null,
    time: null,
    timeUnit: null,
    eventTriggers: [WebhookTriggerEvents.RECORDING_TRANSCRIPTION_GENERATED],
    version: "2021-10-20",
    priority,
  };
}

function createRepository(rows: ReturnType<typeof row>[] = []) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
  const eventTypeRepository = {
    findParentEventTypeId: vi.fn().mockResolvedValue(null),
  } as unknown as IEventTypesRepository;
  const repository = new WebhookRepository(prisma, eventTypeRepository, {} as IUsersRepository);
  return { repository, queryRaw };
}

function memberMeetingsBranchValue(queryRaw: ReturnType<typeof vi.fn>): unknown {
  const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const branchStart = strings.findIndex((part) => part.includes("opted into member meetings"));
  expect(branchStart).toBeGreaterThanOrEqual(0);
  expect(strings.slice(branchStart).join("?")).toContain('"includeMemberMeetings" = true');
  // The first interpolation after the branch comment is its memberSharingTeamIds guard.
  return values[branchStart];
}

const baseOptions = {
  userId: 1,
  triggerEvent: WebhookTriggerEvents.RECORDING_TRANSCRIPTION_GENERATED,
};

describe("WebhookRepository.getSubscribers", () => {
  it("leaves the member meetings branch inert when memberSharingTeamIds is not given", async () => {
    const { repository, queryRaw } = createRepository();
    await repository.getSubscribers(baseOptions);
    expect(memberMeetingsBranchValue(queryRaw)).toBeUndefined();
  });

  it("leaves the member meetings branch inert for an empty memberSharingTeamIds", async () => {
    const { repository, queryRaw } = createRepository();
    await repository.getSubscribers({ ...baseOptions, memberSharingTeamIds: [] });
    expect(memberMeetingsBranchValue(queryRaw)).toBeUndefined();
  });

  it("passes memberSharingTeamIds to the member meetings branch", async () => {
    const { repository, queryRaw } = createRepository();
    await repository.getSubscribers({ ...baseOptions, memberSharingTeamIds: [20] });
    expect(memberMeetingsBranchValue(queryRaw)).toEqual([20]);
  });

  it("returns a webhook matched by several branches once", async () => {
    const { repository } = createRepository([row("wh-user", 2), row("wh-team", 5), row("wh-team", 7)]);
    const subscribers = await repository.getSubscribers({ ...baseOptions, memberSharingTeamIds: [20] });
    expect(subscribers.map((subscriber) => subscriber.id)).toEqual(["wh-user", "wh-team"]);
    expect(subscribers[0]).not.toHaveProperty("priority");
  });
});
