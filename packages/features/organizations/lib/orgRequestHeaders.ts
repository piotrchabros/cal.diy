import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";

// These headers are trusted only because the proxy strips client-supplied copies on every route
// before setting them; anything reading them outside that guarantee must not rely on them.
export const ORG_ID_HEADER = "x-cal-org-id";
export const ORG_SLUG_HEADER = "x-cal-org-slug";
export const ORG_DOMAIN_HEADER = "x-cal-org-domain";
export const ORG_IS_DEFAULT_HEADER = "x-cal-org-default";

export const ORG_REQUEST_HEADERS = [
  ORG_ID_HEADER,
  ORG_SLUG_HEADER,
  ORG_DOMAIN_HEADER,
  ORG_IS_DEFAULT_HEADER,
] as const;

export function stripOrgHeaders(headers: Headers): void {
  for (const header of ORG_REQUEST_HEADERS) {
    headers.delete(header);
  }
}

export function setOrgHeaders(headers: Headers, org: RequestOrganizationDto): void {
  stripOrgHeaders(headers);
  headers.set(ORG_ID_HEADER, String(org.id));
  if (org.slug !== null) headers.set(ORG_SLUG_HEADER, org.slug);
  if (org.domain !== null) headers.set(ORG_DOMAIN_HEADER, org.domain);
  headers.set(ORG_IS_DEFAULT_HEADER, org.isDefault ? "1" : "0");
}

export function readOrgFromHeaders(headers: Pick<Headers, "get">): RequestOrganizationDto | null {
  const rawId = headers.get(ORG_ID_HEADER);
  if (!rawId || !/^\d+$/.test(rawId)) return null;

  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  return {
    id,
    slug: headers.get(ORG_SLUG_HEADER) || null,
    domain: headers.get(ORG_DOMAIN_HEADER) || null,
    isDefault: headers.get(ORG_IS_DEFAULT_HEADER) === "1",
  };
}

export function toHeaderGetter(headers: Record<string, string | string[] | undefined>): Pick<Headers, "get"> {
  return {
    get: (name: string) => {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : (value ?? null);
    },
  };
}
