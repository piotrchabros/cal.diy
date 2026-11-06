import { WEBAPP_URL } from "@calcom/lib/constants";
import { createContext, useContext } from "react";

export type OrgBaseUrlContextValue = { baseUrl: string; orgSlug: string | null };

export const DEFAULT_ORG_BASE_URL_CONTEXT: OrgBaseUrlContextValue = { baseUrl: WEBAPP_URL, orgSlug: null };

export const OrgBaseUrlContext = createContext<OrgBaseUrlContextValue>(DEFAULT_ORG_BASE_URL_CONTEXT);

export function useOrgBaseUrl(): string {
  return useContext(OrgBaseUrlContext).baseUrl;
}
