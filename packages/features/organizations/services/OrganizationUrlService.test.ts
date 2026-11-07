import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationMembershipRepository } from "../tests/InMemoryOrganizationMembershipRepository";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { ORGANIZATION_URL_CACHE_TTL_MS, OrganizationUrlService } from "./OrganizationUrlService";

const constants = vi.hoisted(() => ({ webappUrl: "https://cal.bluebee.marketing" }));

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return {
    ...actual,
    get WEBAPP_URL() {
      return constants.webappUrl;
    },
  };
});

const DEFAULT_DOMAIN = "cal.example.com";
const ORG_URL = "https://cal.bespokesoft.pl";

function setup() {
  const organizationRepository = new InMemoryOrganizationRepository();
  organizationRepository.seed({ id: 1, name: "Default", slug: "default", domain: DEFAULT_DOMAIN });
  organizationRepository.seed({ id: 2, name: "Bespoke", slug: "bespoke", domain: "Cal.Bespokesoft.pl:443" });
  organizationRepository.seed({ id: 3, name: "No domain", slug: "no-domain", domain: null });
  organizationRepository.seed({ id: 4, name: "Local", slug: "local", domain: "localhost:3000" });
  organizationRepository.seedTeam({ id: 2, isOrganization: true });
  organizationRepository.seedTeam({ id: 20, parentId: 2 });
  organizationRepository.seedTeam({ id: 30 });

  const organizationMembershipRepository = new InMemoryOrganizationMembershipRepository();
  organizationMembershipRepository.seedUser({ id: 100, organizationId: 2 });
  organizationMembershipRepository.seedUser({ id: 101, organizationId: null });

  const findDomainById = vi.spyOn(organizationRepository, "findDomainById");
  const findTeamParentById = vi.spyOn(organizationRepository, "findTeamParentById");
  const findUserById = vi.spyOn(organizationMembershipRepository, "findUserById");
  const service = new OrganizationUrlService({
    organizationRepository,
    organizationMembershipRepository,
    organizationsConfig: { defaultDomain: DEFAULT_DOMAIN },
  });
  return { service, organizationRepository, findDomainById, findTeamParentById, findUserById };
}

describe("OrganizationUrlService", () => {
  beforeEach(() => {
    constants.webappUrl = "https://cal.bluebee.marketing";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns WEBAPP_URL without touching the repositories when the flag is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    const { service, findDomainById, findTeamParentById, findUserById } = setup();

    await expect(service.getBaseUrl({ organizationId: 2 })).resolves.toBe(WEBAPP_URL);
    await expect(service.getBaseUrlForUser({ userId: 100 })).resolves.toBe(WEBAPP_URL);
    await expect(service.getBaseUrlForTeam({ teamId: 20 })).resolves.toBe(WEBAPP_URL);
    expect(findDomainById).not.toHaveBeenCalled();
    expect(findTeamParentById).not.toHaveBeenCalled();
    expect(findUserById).not.toHaveBeenCalled();
  });

  it.each([null, undefined])("returns WEBAPP_URL for a %s id", async (id) => {
    const { service, findDomainById, findTeamParentById, findUserById } = setup();

    await expect(service.getBaseUrl({ organizationId: id })).resolves.toBe(WEBAPP_URL);
    await expect(service.getBaseUrlForUser({ userId: id })).resolves.toBe(WEBAPP_URL);
    await expect(service.getBaseUrlForTeam({ teamId: id })).resolves.toBe(WEBAPP_URL);
    expect(findDomainById).not.toHaveBeenCalled();
    expect(findTeamParentById).not.toHaveBeenCalled();
    expect(findUserById).not.toHaveBeenCalled();
  });

  describe("getBaseUrl", () => {
    it("returns the normalized custom domain with WEBAPP_URL's https scheme and no port", async () => {
      const { service } = setup();

      await expect(service.getBaseUrl({ organizationId: 2 })).resolves.toBe(ORG_URL);
    });

    it("carries WEBAPP_URL's http scheme and port onto the custom domain", async () => {
      constants.webappUrl = "http://bluebee.test:3747";
      const { service } = setup();

      await expect(service.getBaseUrl({ organizationId: 2 })).resolves.toBe("http://cal.bespokesoft.pl:3747");
    });

    it.each([
      ["the org on the default domain", 1],
      ["an org on a loopback domain", 4],
    ])("returns the http WEBAPP_URL for %s", async (_label, organizationId) => {
      constants.webappUrl = "http://bluebee.test:3747";
      const { service } = setup();

      await expect(service.getBaseUrl({ organizationId })).resolves.toBe("http://bluebee.test:3747");
    });

    it.each([
      ["an org without a domain", 3],
      ["a missing org", 999],
      ["the org on the default domain", 1],
      ["an org on a loopback domain", 4],
    ])("returns WEBAPP_URL for %s", async (_label, organizationId) => {
      const { service } = setup();

      await expect(service.getBaseUrl({ organizationId })).resolves.toBe(WEBAPP_URL);
    });
  });

  describe("getBaseUrlForUser", () => {
    it("resolves the user's organization", async () => {
      const { service } = setup();

      await expect(service.getBaseUrlForUser({ userId: 100 })).resolves.toBe(ORG_URL);
    });

    it("carries WEBAPP_URL's http scheme and port onto the user's organization domain", async () => {
      constants.webappUrl = "http://bluebee.test:3747";
      const { service } = setup();

      await expect(service.getBaseUrlForUser({ userId: 100 })).resolves.toBe(
        "http://cal.bespokesoft.pl:3747"
      );
    });

    it("returns WEBAPP_URL for a user without an organization", async () => {
      const { service, findDomainById } = setup();

      await expect(service.getBaseUrlForUser({ userId: 101 })).resolves.toBe(WEBAPP_URL);
      expect(findDomainById).not.toHaveBeenCalled();
    });

    it("returns WEBAPP_URL for an unknown user", async () => {
      const { service, findDomainById } = setup();

      await expect(service.getBaseUrlForUser({ userId: 999 })).resolves.toBe(WEBAPP_URL);
      expect(findDomainById).not.toHaveBeenCalled();
    });
  });

  describe("getBaseUrlForEmail", () => {
    it("resolves the organization of the user with that email, ignoring case", async () => {
      const { service } = setup();

      await expect(service.getBaseUrlForEmail({ email: "USER100@example.com" })).resolves.toBe(ORG_URL);
    });

    it.each([
      ["an unknown email", "nobody@example.com"],
      ["a user without an organization", "user101@example.com"],
      ["an empty email", ""],
      ["a null email", null],
    ])("returns WEBAPP_URL for %s", async (_label, email) => {
      const { service } = setup();

      await expect(service.getBaseUrlForEmail({ email })).resolves.toBe(WEBAPP_URL);
    });

    it("does not query when the flag is off", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      const { service, findDomainById } = setup();

      await expect(service.getBaseUrlForEmail({ email: "user100@example.com" })).resolves.toBe(WEBAPP_URL);
      expect(findDomainById).not.toHaveBeenCalled();
    });
  });

  describe("getBaseUrlForTeam", () => {
    it("resolves a sub-team through its parent organization", async () => {
      const { service, findDomainById } = setup();

      await expect(service.getBaseUrlForTeam({ teamId: 20 })).resolves.toBe(ORG_URL);
      expect(findDomainById).toHaveBeenCalledWith(2);
    });

    it("resolves a team that is itself an organization", async () => {
      const { service, findDomainById } = setup();

      await expect(service.getBaseUrlForTeam({ teamId: 2 })).resolves.toBe(ORG_URL);
      expect(findDomainById).toHaveBeenCalledWith(2);
    });

    it.each([
      ["a standalone team", 30],
      ["an unknown team", 999],
    ])("returns WEBAPP_URL for %s", async (_label, teamId) => {
      const { service, findDomainById } = setup();

      await expect(service.getBaseUrlForTeam({ teamId })).resolves.toBe(WEBAPP_URL);
      expect(findDomainById).not.toHaveBeenCalled();
    });
  });

  describe("cache", () => {
    it("serves from cache within the TTL and queries again after it expires", async () => {
      const { service, findDomainById } = setup();

      await service.getBaseUrl({ organizationId: 2 });
      await service.getBaseUrlForUser({ userId: 100 });
      vi.advanceTimersByTime(ORGANIZATION_URL_CACHE_TTL_MS - 1);
      await expect(service.getBaseUrlForTeam({ teamId: 20 })).resolves.toBe(ORG_URL);
      expect(findDomainById).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await expect(service.getBaseUrl({ organizationId: 2 })).resolves.toBe(ORG_URL);
      expect(findDomainById).toHaveBeenCalledTimes(2);
    });

    it("shares one query between concurrent calls", async () => {
      const { service, findDomainById } = setup();

      const results = await Promise.all([
        service.getBaseUrl({ organizationId: 2 }),
        service.getBaseUrl({ organizationId: 2 }),
        service.getBaseUrl({ organizationId: 2 }),
      ]);

      expect(results).toEqual([ORG_URL, ORG_URL, ORG_URL]);
      expect(findDomainById).toHaveBeenCalledTimes(1);
    });

    it("does not cache a rejected lookup", async () => {
      const { service, findDomainById } = setup();
      const error = new Error("database down");
      findDomainById.mockRejectedValueOnce(error);

      await expect(service.getBaseUrl({ organizationId: 2 })).rejects.toBe(error);
      await expect(service.getBaseUrl({ organizationId: 2 })).resolves.toBe(ORG_URL);
      expect(findDomainById).toHaveBeenCalledTimes(2);
    });
  });
});
