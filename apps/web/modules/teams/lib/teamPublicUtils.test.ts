import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { describe, expect, it } from "vitest";
import {
  buildSelectionSearch,
  getMemberEventBookingUrl,
  getMemberProfileUrl,
  getTeamEventBookingUrl,
  parseSelection,
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

  describe("parseSelection", () => {
    it("selects a known member", () => {
      expect(parseSelection(members, { member: "jan", view: null })).toEqual({
        kind: "member",
        username: "jan",
      });
    });

    it("selects the whole team view", () => {
      expect(parseSelection(members, { member: null, view: "team" })).toEqual({ kind: "team" });
    });

    it("falls back to the overview for unknown or missing values", () => {
      expect(parseSelection(members, { member: "nobody", view: null })).toEqual({ kind: "overview" });
      expect(parseSelection(members, { member: null, view: "other" })).toEqual({ kind: "overview" });
    });
  });

  describe("buildSelectionSearch", () => {
    it("sets the member param and keeps others", () => {
      expect(buildSelectionSearch("", { kind: "member", username: "anna" })).toBe("?member=anna");
      expect(buildSelectionSearch("?a=1&view=team", { kind: "member", username: "anna" })).toBe(
        "?a=1&member=anna"
      );
    });

    it("sets the team view param", () => {
      expect(buildSelectionSearch("?member=anna", { kind: "team" })).toBe("?view=team");
    });

    it("clears both params for the overview", () => {
      expect(buildSelectionSearch("?member=anna", { kind: "overview" })).toBe("");
      expect(buildSelectionSearch("?a=1&view=team", { kind: "overview" })).toBe("?a=1");
    });
  });
});
