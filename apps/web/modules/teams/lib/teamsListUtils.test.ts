import { describe, expect, it } from "vitest";

import { getTeamInitials, getTeamPublicUrl } from "./teamsListUtils";

describe("getTeamInitials", () => {
  it("returns the first two letters for a single-word name", () => {
    expect(getTeamInitials("BlueBee")).toBe("BL");
  });

  it("returns the first letter of the first two words", () => {
    expect(getTeamInitials("Blue Bee Collective")).toBe("BB");
  });

  it("uppercases lowercase names", () => {
    expect(getTeamInitials("acme")).toBe("AC");
  });

  it("trims surrounding whitespace", () => {
    expect(getTeamInitials("  Acme Inc  ")).toBe("AI");
  });

  it("returns an empty string for a blank name", () => {
    expect(getTeamInitials("   ")).toBe("");
  });
});

describe("getTeamPublicUrl", () => {
  it("builds the public team URL from the webapp URL and slug", () => {
    expect(getTeamPublicUrl("https://cal.eu", "bluebee")).toBe("https://cal.eu/team/bluebee");
  });

  it("tolerates a trailing slash on the webapp URL", () => {
    expect(getTeamPublicUrl("https://cal.eu/", "bluebee")).toBe("https://cal.eu/team/bluebee");
  });

  it("returns null when the team has no slug", () => {
    expect(getTeamPublicUrl("https://cal.eu", null)).toBeNull();
  });
});
