import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutOrganizationParent } from "./withoutOrganizationParent";

const team = { id: 2, name: "Sales", parentId: 1, parent: { name: "BlueBee", logoUrl: null } };

describe("withoutOrganizationParent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the organization parent when organizations are enabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(withoutOrganizationParent(team)).toEqual(team);
  });

  it("drops the organization parent when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(withoutOrganizationParent(team)).toEqual({ id: 2, name: "Sales", parentId: null, parent: null });
  });

  it("does not mutate the given team", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    withoutOrganizationParent(team);

    expect(team.parentId).toBe(1);
  });
});
