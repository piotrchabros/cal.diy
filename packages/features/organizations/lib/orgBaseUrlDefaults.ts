import { WEBAPP_URL } from "@calcom/lib/constants";

export type OrgBaseUrlContextValue = { baseUrl: string; orgSlug: string | null };

export const DEFAULT_ORG_BASE_URL_CONTEXT: OrgBaseUrlContextValue = { baseUrl: WEBAPP_URL, orgSlug: null };
