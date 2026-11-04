import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import { WebhookOutputMapper } from "./WebhookOutputMapper";

const prismaWebhook = {
  id: "wh-1",
  subscriberUrl: "https://crm.example.com/hooks/calcom",
  payloadTemplate: null,
  appId: null,
  secret: null,
  active: true,
  eventTriggers: [WebhookTriggerEvents.BOOKING_CREATED],
  eventTypeId: null,
  teamId: 3,
  userId: null,
  time: null,
  timeUnit: null,
  version: "2021-10-20",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  platform: false,
  platformOAuthClientId: null,
  includeMemberMeetings: true,
};

describe("WebhookOutputMapper.toWebhook", () => {
  it("maps includeMemberMeetings", () => {
    expect(WebhookOutputMapper.toWebhook(prismaWebhook).includeMemberMeetings).toBe(true);
    expect(
      WebhookOutputMapper.toWebhook({ ...prismaWebhook, includeMemberMeetings: false }).includeMemberMeetings
    ).toBe(false);
  });
});
