import { afterEach, describe, expect, it, vi } from "vitest";
import { isOrganizationTeam } from "./isOrganizationTeam";

describe("isOrganizationTeam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats a team with a parent as an organization team when organizations are enabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(isOrganizationTeam({ parentId: 1 })).toBe(true);
    expect(isOrganizationTeam({ parentId: null })).toBe(false);
    expect(isOrganizationTeam(null)).toBe(false);
  });

  it("treats every team as top-level when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(isOrganizationTeam({ parentId: 1 })).toBe(false);
    expect(isOrganizationTeam({ parentId: null })).toBe(false);
    expect(isOrganizationTeam(undefined)).toBe(false);
  });
});
