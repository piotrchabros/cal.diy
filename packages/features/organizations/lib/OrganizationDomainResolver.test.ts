import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { ORGANIZATION_DOMAIN_CACHE_TTL_MS, OrganizationDomainResolver } from "./OrganizationDomainResolver";

const DEFAULT_DOMAIN = "cal.example.com";

function setup(defaultDomain: string | null = DEFAULT_DOMAIN) {
  const organizationRepository = new InMemoryOrganizationRepository();
  organizationRepository.seed({ id: 1, name: "Default", slug: "default", domain: DEFAULT_DOMAIN });
  organizationRepository.seed({ id: 2, name: "Acme", slug: "acme", domain: "cal.acme.com" });
  const findByDomain = vi.spyOn(organizationRepository, "findByDomain");
  const findDefault = vi.spyOn(organizationRepository, "findDefault");
  const resolver = new OrganizationDomainResolver({
    organizationRepository,
    organizationsConfig: { defaultDomain },
  });
  return { organizationRepository, findByDomain, findDefault, resolver };
}

const defaultOrg = { id: 1, slug: "default", domain: DEFAULT_DOMAIN, isDefault: true };
const acmeOrg = { id: 2, slug: "acme", domain: "cal.acme.com", isDefault: false };

describe("OrganizationDomainResolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("resolves any host to the default org when the flag is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    const { resolver, findByDomain } = setup();

    await expect(resolver.resolve("cal.acme.com")).resolves.toEqual(defaultOrg);
    await expect(resolver.resolve("unknown.example.org")).resolves.toEqual(defaultOrg);
    expect(findByDomain).not.toHaveBeenCalled();
  });

  it.each([
    "localhost:3000",
    "127.0.0.1",
    "[::1]",
  ])("resolves loopback host %s to the default org", async (host) => {
    const { resolver, findByDomain } = setup();

    await expect(resolver.resolve(host)).resolves.toEqual(defaultOrg);
    expect(findByDomain).not.toHaveBeenCalled();
  });

  it("resolves a known domain regardless of port and case", async () => {
    const { resolver, findByDomain } = setup();

    await expect(resolver.resolve("CAL.Acme.COM:443")).resolves.toEqual(acmeOrg);
    expect(findByDomain).toHaveBeenCalledWith("cal.acme.com");
  });

  it("marks the org on the default domain as default", async () => {
    const { resolver } = setup();

    await expect(resolver.resolve("Cal.Example.com:8080")).resolves.toEqual(defaultOrg);
  });

  it("returns null for an unknown host and caches the miss", async () => {
    const { resolver, findByDomain } = setup();

    await expect(resolver.resolve("unknown.example.org")).resolves.toBeNull();
    await expect(resolver.resolve("unknown.example.org")).resolves.toBeNull();
    expect(findByDomain).toHaveBeenCalledTimes(1);
  });

  it("serves from cache within the TTL and queries again after it expires", async () => {
    const { resolver, findByDomain } = setup();

    await resolver.resolve("cal.acme.com");
    vi.advanceTimersByTime(ORGANIZATION_DOMAIN_CACHE_TTL_MS - 1000);
    await resolver.resolve("cal.acme.com");
    expect(findByDomain).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await resolver.resolve("cal.acme.com");
    expect(findByDomain).toHaveBeenCalledTimes(2);
  });

  it("shares one query between concurrent lookups of the same host", async () => {
    const { resolver, findByDomain } = setup();

    const results = await Promise.all([
      resolver.resolve("cal.acme.com"),
      resolver.resolve("cal.acme.com:443"),
      resolver.resolve("CAL.ACME.COM"),
    ]);

    expect(results).toEqual([acmeOrg, acmeOrg, acmeOrg]);
    expect(findByDomain).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup", async () => {
    const { resolver, findByDomain } = setup();
    findByDomain.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(resolver.resolve("cal.acme.com")).rejects.toThrow("database unavailable");
    await expect(resolver.resolve("cal.acme.com")).resolves.toEqual(acmeOrg);
    expect(findByDomain).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined, "", "   "])("returns null for empty host %j", async (host) => {
    const { resolver, findByDomain } = setup();

    await expect(resolver.resolve(host)).resolves.toBeNull();
    expect(findByDomain).not.toHaveBeenCalled();
  });

  it("returns null when the default org does not exist", async () => {
    const { resolver, organizationRepository } = setup();
    await organizationRepository.delete(1);

    await expect(resolver.resolve("localhost")).resolves.toBeNull();
  });

  it("returns null for a loopback host when there is no default domain", async () => {
    const { resolver, findDefault } = setup(null);

    await expect(resolver.resolve("localhost:3000")).resolves.toBeNull();
    expect(findDefault).not.toHaveBeenCalled();
  });

  describe("resolveDefault", () => {
    it("returns the default org and caches the hit", async () => {
      const { resolver, findDefault } = setup();

      await expect(resolver.resolveDefault()).resolves.toEqual(defaultOrg);
      await expect(resolver.resolveDefault()).resolves.toEqual(defaultOrg);
      expect(findDefault).toHaveBeenCalledTimes(1);
    });

    it("does not cache a missing default org", async () => {
      const { resolver, organizationRepository, findDefault } = setup();
      await organizationRepository.delete(1);

      await expect(resolver.resolveDefault()).resolves.toBeNull();
      await expect(resolver.resolveDefault()).resolves.toBeNull();
      expect(findDefault).toHaveBeenCalledTimes(2);
    });

    it("ignores a miss cached by resolve() so a newly created default org is found", async () => {
      const { resolver, organizationRepository, findDefault } = setup();
      await organizationRepository.delete(1);

      await expect(resolver.resolve("localhost")).resolves.toBeNull();
      await expect(resolver.resolve("localhost")).resolves.toBeNull();
      expect(findDefault).toHaveBeenCalledTimes(1);

      await expect(resolver.resolveDefault()).resolves.toBeNull();
      expect(findDefault).toHaveBeenCalledTimes(2);
    });

    it("returns null without a lookup when there is no default domain", async () => {
      const { resolver, findDefault } = setup(null);

      await expect(resolver.resolveDefault()).resolves.toBeNull();
      expect(findDefault).not.toHaveBeenCalled();
    });
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const { resolver, findByDomain } = setup();

    await resolver.resolve("cal.acme.com");
    for (let index = 0; index < 999; index++) {
      await resolver.resolve(`host-${index}.example.org`);
    }
    await resolver.resolve("cal.acme.com");
    expect(findByDomain).toHaveBeenCalledTimes(1000);

    await resolver.resolve("one-more.example.org");
    await resolver.resolve("cal.acme.com");
    expect(findByDomain).toHaveBeenCalledTimes(1002);
  });
});
