import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { getOrgFromRequest } from "./getOrgFromRequest";
import { OrganizationDomainResolver } from "./OrganizationDomainResolver";
import {
  ORG_DOMAIN_HEADER,
  ORG_ID_HEADER,
  ORG_IS_DEFAULT_HEADER,
  ORG_REQUEST_HEADERS,
  ORG_SLUG_HEADER,
  readOrgFromHeaders,
  setOrgHeaders,
  stripOrgHeaders,
} from "./orgRequestHeaders";

const { resolverHolder } = vi.hoisted(() => ({
  resolverHolder: { current: null as OrganizationDomainResolver | null },
}));

vi.mock("../di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver: () => {
    if (!resolverHolder.current) throw new Error("resolver not set up");
    return resolverHolder.current;
  },
}));

describe("getOrgFromRequest", () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    const organizationRepository = new InMemoryOrganizationRepository();
    organizationRepository.seed({ id: 1, name: "Default", slug: "default", domain: "cal.example.com" });
    organizationRepository.seed({ id: 2, name: "Acme", slug: "acme", domain: "cal.acme.com" });
    resolverHolder.current = new OrganizationDomainResolver({
      organizationRepository,
      organizationsConfig: { defaultDomain: "cal.example.com" },
    });
    resolveSpy = vi.spyOn(resolverHolder.current, "resolve");
  });

  it("returns the org from trusted headers without calling the resolver", async () => {
    const headers = new Headers({
      host: "cal.acme.com",
      [ORG_ID_HEADER]: "7",
      [ORG_SLUG_HEADER]: "seven",
      [ORG_DOMAIN_HEADER]: "seven.example.com",
      [ORG_IS_DEFAULT_HEADER]: "0",
    });

    await expect(getOrgFromRequest(headers)).resolves.toEqual({
      id: 7,
      slug: "seven",
      domain: "seven.example.com",
      isDefault: false,
    });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it.each([
    "abc",
    "0",
    "-3",
    "1.5",
    "",
  ])("falls back to the resolver when the id header is %j", async (id) => {
    const headers = new Headers({ host: "cal.acme.com", [ORG_ID_HEADER]: id, [ORG_SLUG_HEADER]: "forged" });

    await expect(getOrgFromRequest(headers)).resolves.toEqual({
      id: 2,
      slug: "acme",
      domain: "cal.acme.com",
      isDefault: false,
    });
    expect(resolveSpy).toHaveBeenCalledWith("cal.acme.com");
  });

  it("resolves from the host when no org headers are present", async () => {
    await expect(getOrgFromRequest(new Headers({ host: "cal.example.com" }))).resolves.toEqual({
      id: 1,
      slug: "default",
      domain: "cal.example.com",
      isDefault: true,
    });
  });

  it("returns null for an unknown host without org headers", async () => {
    await expect(getOrgFromRequest(new Headers({ host: "unknown.example.org" }))).resolves.toBeNull();
  });
});

describe("orgRequestHeaders", () => {
  it("round-trips an org through setOrgHeaders and readOrgFromHeaders", () => {
    const headers = new Headers();
    const org = { id: 3, slug: "acme", domain: "cal.acme.com", isDefault: true };

    setOrgHeaders(headers, org);

    expect(headers.get(ORG_IS_DEFAULT_HEADER)).toBe("1");
    expect(readOrgFromHeaders(headers)).toEqual(org);
  });

  it("omits slug and domain headers when they are null", () => {
    const headers = new Headers({ [ORG_SLUG_HEADER]: "stale", [ORG_DOMAIN_HEADER]: "stale.example.com" });

    setOrgHeaders(headers, { id: 4, slug: null, domain: null, isDefault: false });

    expect(headers.has(ORG_SLUG_HEADER)).toBe(false);
    expect(headers.has(ORG_DOMAIN_HEADER)).toBe(false);
    expect(headers.get(ORG_IS_DEFAULT_HEADER)).toBe("0");
    expect(readOrgFromHeaders(headers)).toEqual({ id: 4, slug: null, domain: null, isDefault: false });
  });

  it("stripOrgHeaders removes all four org headers", () => {
    const headers = new Headers({
      host: "cal.acme.com",
      [ORG_ID_HEADER]: "1",
      [ORG_SLUG_HEADER]: "acme",
      [ORG_DOMAIN_HEADER]: "cal.acme.com",
      [ORG_IS_DEFAULT_HEADER]: "1",
    });

    stripOrgHeaders(headers);

    for (const header of ORG_REQUEST_HEADERS) {
      expect(headers.has(header)).toBe(false);
    }
    expect(headers.get("host")).toBe("cal.acme.com");
  });

  it("returns null when the id header is missing", () => {
    expect(readOrgFromHeaders(new Headers({ [ORG_SLUG_HEADER]: "acme" }))).toBeNull();
  });
});
