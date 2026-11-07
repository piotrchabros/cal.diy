import type { VerticalTabItemProps } from "@calcom/ui/components/navigation";

const ORGANIZATION_ADMIN_TABS: VerticalTabItemProps[] = [
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
];

export const withOrganizationAdminTabs = (
  children: VerticalTabItemProps[] | undefined
): VerticalTabItemProps[] => {
  const result = [...(children ?? [])];
  const usersIndex = result.findIndex((child) => child.name === "users");
  result.splice(usersIndex === -1 ? result.length : usersIndex + 1, 0, ...ORGANIZATION_ADMIN_TABS);
  return result;
};
