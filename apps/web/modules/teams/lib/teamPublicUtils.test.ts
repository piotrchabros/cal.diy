import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { describe, expect, it } from "vitest";
import {
  buildMemberSearch,
  getMemberEventBookingUrl,
  getMemberProfileUrl,
  getTeamEventBookingUrl,
  resolveSelectedMember,
} from "./teamPublicUtils";

const members: PublicTeamMemberDto[] = [
  { username: "anna", name: "Anna", avatarUrl: "", eventTypes: [] },
  { username: "jan", name: "Jan", avatarUrl: "", eventTypes: [] },
];

describe("teamPublicUtils", () => {
  describe("getTeamEventBookingUrl", () => {
    it("builds the booking url for a team event type", () => {
      expect(getTeamEventBookingUrl("bluebee", "demo")).toBe("/team/bluebee/demo");
    });
  });

  describe("getMemberEventBookingUrl", () => {
    it("builds an encoded member booking url", () => {
      expect(getMemberEventBookingUrl("anna", "demo")).toBe("/anna/demo");
      expect(getMemberEventBookingUrl("a b", "x/y")).toBe("/a%20b/x%2Fy");
    });
  });

  describe("getMemberProfileUrl", () => {
    it("builds an encoded profile url", () => {
      expect(getMemberProfileUrl("anna")).toBe("/anna");
      expect(getMemberProfileUrl("a b")).toBe("/a%20b");
    });
  });

  describe("resolveSelectedMember", () => {
    it("returns the matching member", () => {
      expect(resolveSelectedMember(members, "jan")).toBe(members[1]);
    });

    it("returns null for null or unknown usernames", () => {
      expect(resolveSelectedMember(members, null)).toBeNull();
      expect(resolveSelectedMember(members, "nobody")).toBeNull();
    });
  });

  describe("buildMemberSearch", () => {
    it("sets the member param and keeps others", () => {
      expect(buildMemberSearch("", "anna")).toBe("?member=anna");
      expect(buildMemberSearch("?a=1&member=jan", "anna")).toBe("?a=1&member=anna");
    });

    it("removes the member param", () => {
      expect(buildMemberSearch("?member=anna", null)).toBe("");
      expect(buildMemberSearch("?a=1&member=anna", null)).toBe("?a=1");
    });
  });
});
