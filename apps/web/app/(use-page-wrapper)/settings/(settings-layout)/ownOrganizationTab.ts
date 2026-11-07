import type { VerticalTabItemProps } from "@calcom/ui/components/navigation";

export const getOwnOrganizationTab = ({
  enabled,
  organizationId,
}: {
  enabled: boolean | undefined;
  organizationId: number | null | undefined;
}): VerticalTabItemProps | null => {
  if (!enabled || !organizationId) return null;

  return {
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
  };
};
