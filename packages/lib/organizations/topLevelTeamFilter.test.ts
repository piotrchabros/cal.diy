import { afterEach, describe, expect, it, vi } from "vitest";
import { topLevelTeamFilter } from "./topLevelTeamFilter";

describe("topLevelTeamFilter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches teams without a parent when organizations are enabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    expect(topLevelTeamFilter()).toEqual({ parentId: null });
  });

  it("matches every non-organization team when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    expect(topLevelTeamFilter()).toEqual({ isOrganization: false });
  });
});
