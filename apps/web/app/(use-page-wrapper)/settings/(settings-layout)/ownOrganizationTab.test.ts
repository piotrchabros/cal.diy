import { describe, expect, it } from "vitest";
import { getOwnOrganizationTab } from "./ownOrganizationTab";

describe("getOwnOrganizationTab", () => {
  it("returns null when the organizations feature is disabled", () => {
    expect(getOwnOrganizationTab({ enabled: false, organizationId: 5 })).toBeNull();
    expect(getOwnOrganizationTab({ enabled: undefined, organizationId: 5 })).toBeNull();
  });

  it("returns null when the user has no organization", () => {
    expect(getOwnOrganizationTab({ enabled: true, organizationId: null })).toBeNull();
    expect(getOwnOrganizationTab({ enabled: true, organizationId: undefined })).toBeNull();
  });

  it("returns the organization tab with members and teams links", () => {
    const tab = getOwnOrganizationTab({ enabled: true, organizationId: 5 });

    expect(tab).toEqual({
      name: "organization",
      href: "/settings/organization",
      icon: "building",
      children: [
        {
          name: "members",
          href: "/settings/organization/members",
          trackingMetadata: { section: "organization", page: "members" },
        },
        {
          name: "teams",
          href: "/settings/organization/teams",
          trackingMetadata: { section: "organization", page: "teams" },
        },
      ],
    });
  });

  it("does not point at the upstream /settings/organizations pages", () => {
    const tab = getOwnOrganizationTab({ enabled: true, organizationId: 5 });

    for (const child of tab?.children ?? []) {
      expect(child.href?.startsWith("/settings/organizations")).toBe(false);
    }
  });
});
