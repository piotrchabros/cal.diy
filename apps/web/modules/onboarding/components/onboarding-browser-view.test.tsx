import { describe, expect, it } from "vitest";
import { getDisplayUrl } from "./onboarding-browser-view";

describe("getDisplayUrl", () => {
  it("strips the protocol and appends the username", () => {
    expect(getDisplayUrl("https://acme.test", "john", undefined)).toBe("acme.test/john");
  });

  it("uses the team path when a team slug is given", () => {
    expect(getDisplayUrl("http://localhost:3000", "john", "sales")).toBe("localhost:3000/team/sales");
  });

  it("keeps an empty team slug on the team path", () => {
    expect(getDisplayUrl("https://acme.test", null, "")).toBe("acme.test/team/");
  });
});
