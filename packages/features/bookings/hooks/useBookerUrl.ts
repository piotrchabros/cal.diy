import { useOrgBaseUrl } from "@calcom/features/organizations/lib/OrgBaseUrlContext";

export const useBookerUrl = (): string => useOrgBaseUrl();

export const useEmbedBookerUrl = (): string => useOrgBaseUrl();
