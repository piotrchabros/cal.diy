import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationMembershipRepository } from "../tests/InMemoryOrganizationMembershipRepository";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { OrganizationSignInService } from "./OrganizationSignInService";
import { OrganizationUrlService } from "./OrganizationUrlService";

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ info: mockLogInfo, warn: mockLogWarn }) },
}));

const DEFAULT_DOMAIN = "cal.example.com";
const DEFAULT_ORG_ID = 1;
const ORG_A_ID = 2;
const ORG_B_ID = 3;
const ORG_WITHOUT_DOMAIN_ID = 4;
const ORG_A_HOST = "cal.acme.com";
const ORG_B_HOST = "cal.bespokesoft.pl";
const WEBAPP_HOST = new URL(WEBAPP_URL).host;
const REASON_QUERY = "?reason=wrong_organization_domain";
const ERROR_QUERY = "?error=wrong_organization_domain";

function setup() {
  const organizationRepository = new InMemoryOrganizationRepository();
  organizationRepository.seed({
    id: DEFAULT_ORG_ID,
    name: "Default",
    slug: "default",
    domain: DEFAULT_DOMAIN,
  });
  organizationRepository.seed({ id: ORG_A_ID, name: "Acme", slug: "acme", domain: ORG_A_HOST });
  organizationRepository.seed({ id: ORG_B_ID, name: "Bespoke", slug: "bespoke", domain: ORG_B_HOST });
  organizationRepository.seed({ id: ORG_WITHOUT_DOMAIN_ID, name: "No domain", slug: "no-domain" });

  const organizationMembershipRepository = new InMemoryOrganizationMembershipRepository();
  organizationMembershipRepository.seedUser({ id: 100, email: "alice@acme.com", organizationId: ORG_A_ID });
  organizationMembershipRepository.seedUser({ id: 101, email: "bob@bespoke.pl", organizationId: ORG_B_ID });
  organizationMembershipRepository.seedUser({ id: 102, email: "carol@solo.com", organizationId: null });
  organizationMembershipRepository.seedUser({
    id: 103,
    email: "dave@nodomain.com",
    organizationId: ORG_WITHOUT_DOMAIN_ID,
  });

  const organizationUrlService = new OrganizationUrlService({
    organizationRepository,
    organizationMembershipRepository,
    organizationsConfig: { defaultDomain: DEFAULT_DOMAIN },
  });
  const findUserByEmail = vi.spyOn(organizationMembershipRepository, "findUserByEmail");
  const service = new OrganizationSignInService({ organizationMembershipRepository, organizationUrlService });
  return { service, findUserByEmail };
}

describe("OrganizationSignInService.checkSignInDomain", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows sign-in without touching the repository when the flag is off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    const { service, findUserByEmail } = setup();

    await expect(
      service.checkSignInDomain({
        email: "bob@bespoke.pl",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "allowed" });
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ""])("refuses sign-in for a %j email", async (email) => {
    const { service, findUserByEmail } = setup();

    await expect(
      service.checkSignInDomain({ email, requestOrganizationId: ORG_A_ID, requestHost: ORG_A_HOST })
    ).resolves.toEqual({ kind: "refused", errorUrl: `${WEBAPP_URL}/auth/error${ERROR_QUERY}` });
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  it("allows sign-in for an unknown email", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({
        email: "nobody@acme.com",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "allowed" });
  });

  it("allows a user signing in on their own organization's host", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({
        email: "alice@acme.com",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "allowed" });
  });

  it("allows a user without an organization on a host without an organization", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({ email: "carol@solo.com", requestOrganizationId: null, requestHost: null })
    ).resolves.toEqual({ kind: "allowed" });
  });

  it("matches the email case-insensitively", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({
        email: "ALICE@Acme.com",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "allowed" });
    await expect(
      service.checkSignInDomain({
        email: "BOB@Bespoke.PL",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "redirect", loginUrl: `https://${ORG_B_HOST}/auth/login${REASON_QUERY}` });
  });

  it("redirects a user of another organization to their organization's login page", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({
        email: "bob@bespoke.pl",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "redirect", loginUrl: `https://${ORG_B_HOST}/auth/login${REASON_QUERY}` });
  });

  it("redirects a user without an organization from an organization host to the webapp login", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({
        email: "carol@solo.com",
        requestOrganizationId: ORG_A_ID,
        requestHost: ORG_A_HOST,
      })
    ).resolves.toEqual({ kind: "redirect", loginUrl: `${WEBAPP_URL}/auth/login${REASON_QUERY}` });
  });

  it("refuses instead of redirecting when the user's base URL host is the request host", async () => {
    const { service } = setup();

    await expect(
      service.checkSignInDomain({
        email: "dave@nodomain.com",
        requestOrganizationId: DEFAULT_ORG_ID,
        requestHost: WEBAPP_HOST.toUpperCase(),
      })
    ).resolves.toEqual({ kind: "refused", errorUrl: `${WEBAPP_URL}/auth/error${ERROR_QUERY}` });
  });

  it("logs decisions with ids only, never the email", async () => {
    const { service } = setup();

    await service.checkSignInDomain({
      email: "bob@bespoke.pl",
      requestOrganizationId: ORG_A_ID,
      requestHost: ORG_A_HOST,
    });
    await service.checkSignInDomain({
      email: "dave@nodomain.com",
      requestOrganizationId: DEFAULT_ORG_ID,
      requestHost: WEBAPP_HOST,
    });

    expect(mockLogInfo).toHaveBeenCalledWith(expect.any(String), {
      userId: 101,
      userOrganizationId: ORG_B_ID,
      requestOrganizationId: ORG_A_ID,
    });
    expect(mockLogWarn).toHaveBeenCalledWith(expect.any(String), {
      userId: 103,
      userOrganizationId: ORG_WITHOUT_DOMAIN_ID,
      requestOrganizationId: DEFAULT_ORG_ID,
    });
    const logged = JSON.stringify([...mockLogInfo.mock.calls, ...mockLogWarn.mock.calls]);
    expect(logged).not.toContain("@");
  });
});
