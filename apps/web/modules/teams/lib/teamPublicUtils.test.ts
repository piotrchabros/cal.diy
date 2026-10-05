import { describe, expect, it } from "vitest";
import { getTeamEventBookingUrl } from "./teamPublicUtils";

describe("teamPublicUtils", () => {
  describe("getTeamEventBookingUrl", () => {
    it("builds the booking url for a team event type", () => {
      expect(getTeamEventBookingUrl("bluebee", "demo")).toBe("/team/bluebee/demo");
    });
  });
});
