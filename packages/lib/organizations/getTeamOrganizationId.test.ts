import { describe, expect, it } from "vitest";
import { getTeamOrganizationId } from "./getTeamOrganizationId";

describe("getTeamOrganizationId", () => {
  it("returns the team's own id when the team is an organization", () => {
    expect(getTeamOrganizationId({ id: 7, isOrganization: true, parentId: null })).toBe(7);
  });

  it("returns the parent id for a team inside an organization", () => {
    expect(getTeamOrganizationId({ id: 8, isOrganization: false, parentId: 7 })).toBe(7);
  });

  it("returns null for a top-level team outside any organization", () => {
    expect(getTeamOrganizationId({ id: 9, isOrganization: false, parentId: null })).toBeNull();
  });
});
