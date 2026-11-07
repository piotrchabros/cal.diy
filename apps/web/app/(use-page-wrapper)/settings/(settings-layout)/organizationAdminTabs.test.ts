import type { VerticalTabItemProps } from "@calcom/ui/components/navigation";
import { describe, expect, it } from "vitest";
import { withOrganizationAdminTabs } from "./organizationAdminTabs";

const tab = (name: string): VerticalTabItemProps => ({ name, href: `/settings/admin/${name}` });

describe("withOrganizationAdminTabs", () => {
  it("inserts the organizations and teams tabs right after users", () => {
    const result = withOrganizationAdminTabs([tab("features"), tab("users"), tab("apps")]);

    expect(result.map((child) => child.name)).toEqual([
      "features",
      "users",
      "organizations",
      "teams",
      "apps",
    ]);
  });

  it("appends the tabs at the end when there is no users tab", () => {
    const result = withOrganizationAdminTabs([tab("features"), tab("apps")]);

    expect(result.map((child) => child.name)).toEqual(["features", "apps", "organizations", "teams"]);
  });

  it("returns only the organization admin tabs when there are no children", () => {
    expect(withOrganizationAdminTabs(undefined).map((child) => child.name)).toEqual([
      "organizations",
      "teams",
    ]);
  });

  it("links the tabs to the admin pages with admin tracking metadata", () => {
    const result = withOrganizationAdminTabs([tab("users")]);

    expect(result.slice(1)).toEqual([
      {
        name: "organizations",
        href: "/settings/admin/organizations",
        trackingMetadata: { section: "admin", page: "organizations" },
      },
      {
        name: "teams",
        href: "/settings/admin/teams",
        trackingMetadata: { section: "admin", page: "teams" },
      },
    ]);
  });

  it("does not mutate the input", () => {
    const children = [tab("users"), tab("apps")];
    const snapshot = structuredClone(children);

    const result = withOrganizationAdminTabs(children);

    expect(result).not.toBe(children);
    expect(children).toEqual(snapshot);
  });
});
