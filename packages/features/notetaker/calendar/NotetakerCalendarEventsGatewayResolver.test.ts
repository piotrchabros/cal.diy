import { describe, expect, it } from "vitest";
import type { INotetakerCalendarEventsGateway } from "./INotetakerCalendarEventsGateway";
import {
  GOOGLE_CALENDAR_INTEGRATION,
  NotetakerCalendarEventsGatewayResolver,
} from "./NotetakerCalendarEventsGatewayResolver";

const googleGateway: INotetakerCalendarEventsGateway = { listEvents: async () => [] };

describe("NotetakerCalendarEventsGatewayResolver", () => {
  const resolver = new NotetakerCalendarEventsGatewayResolver({
    gateways: { [GOOGLE_CALENDAR_INTEGRATION]: googleGateway },
  });

  it("resolves the gateway registered for an integration", () => {
    expect(resolver.resolve("google_calendar")).toBe(googleGateway);
  });

  it("returns null for an integration without a gateway, including inherited object keys", () => {
    expect(resolver.resolve("office365_calendar")).toBeNull();
    expect(resolver.resolve("toString")).toBeNull();
  });

  it("lists the supported integrations", () => {
    expect(resolver.supportedIntegrations()).toEqual(["google_calendar"]);
  });
});
