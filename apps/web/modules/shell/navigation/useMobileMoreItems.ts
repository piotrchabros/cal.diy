import { useOrgBaseUrl } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { useSession } from "next-auth/react";
import { useBottomNavItems } from "../useBottomNavItems";
import type { NavigationItemType } from "./NavigationItem";

export function useMobileMoreItems(): NavigationItemType[] {
  const { data: session } = useSession();
  const user = session?.user;
  const orgBaseUrl = useOrgBaseUrl();
  const publicPageUrl = `${orgBaseUrl}/${user?.orgAwareUsername ?? user?.username}`;

  const bottomNavItems = useBottomNavItems({
    publicPageUrl,
  });

  const filteredBottomNavItems = bottomNavItems.filter(
    (item: NavigationItemType) => item.name !== "settings"
  );
  return filteredBottomNavItems;
}
