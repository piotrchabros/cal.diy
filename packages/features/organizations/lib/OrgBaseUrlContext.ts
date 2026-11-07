import { WEBAPP_URL } from "@calcom/lib/constants";
import { createContext, useContext } from "react";

export type OrgBaseUrlContextValue = { baseUrl: string; orgSlug: string | null };

export const DEFAULT_ORG_BASE_URL_CONTEXT: OrgBaseUrlContextValue = { baseUrl: WEBAPP_URL, orgSlug: null };

export const OrgBaseUrlContext = createContext<OrgBaseUrlContextValue>(DEFAULT_ORG_BASE_URL_CONTEXT);

export function useOrgBaseUrl(): string {
  return useContext(OrgBaseUrlContext).baseUrl;
}

// WEBSITE_URL can differ from WEBAPP_URL, so off an organization host callers keep their historical fallback.
export function useOrgBaseUrlOr<T extends string | undefined>(fallback: T): string | T {
  const { baseUrl, orgSlug } = useContext(OrgBaseUrlContext);
  return orgSlug ? baseUrl : fallback;
}
