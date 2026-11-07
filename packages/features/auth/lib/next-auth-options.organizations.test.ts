import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const mockIsOrganizationsEnabled = vi.fn();
const mockGetOrgFromRequest = vi.fn();
const mockCheckSignInDomain = vi.fn();
const mockGetOrganizationOriginForUrl = vi.fn();
const mockGetBaseUrl = vi.fn();

vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: () => mockIsOrganizationsEnabled(),
}));

vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: (...args: unknown[]) => mockGetOrgFromRequest(...args),
}));

vi.mock("@calcom/features/organizations/di/OrganizationSignInService.container", () => ({
  getOrganizationSignInService: () => ({ checkSignInDomain: mockCheckSignInDomain }),
}));

vi.mock("@calcom/features/organizations/lib/getOrganizationOrigin", () => ({
  getOrganizationOriginForUrl: (...args: unknown[]) => mockGetOrganizationOriginForUrl(...args),
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: mockGetBaseUrl }),
}));

const mockFindDefaultOrganizationId = vi.fn();
const mockAddMember = vi.fn();

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember: mockAddMember }),
}));

vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  findDefaultOrganizationId: () => mockFindDefaultOrganizationId(),
}));

const mockAcceptPendingInvitesOnSignup = vi.fn();

vi.mock("@calcom/features/membership/services/TeamMembersService", () => ({
  TeamMembersService: class {
    acceptPendingInvitesOnSignup(...args: unknown[]) {
      return mockAcceptPendingInvitesOnSignup(...args);
    }
  },
}));

const mockIsSessionInRequestOrganization = vi.fn();

vi.mock("./isSessionInRequestOrganization", () => ({
  isSessionInRequestOrganization: (...args: unknown[]) => mockIsSessionInRequestOrganization(...args),
}));

const mockPrismaUserFindFirst = vi.fn();
const mockPrismaUserCreate = vi.fn();
const mockPrismaUserDelete = vi.fn();
const mockPrismaTeamFindFirst = vi.fn();
const mockPrismaMembershipFindUnique = vi.fn();

vi.mock("@calcom/prisma", () => {
  const client = {
    user: {
      findFirst: (...args: unknown[]) => mockPrismaUserFindFirst(...args),
      create: (...args: unknown[]) => mockPrismaUserCreate(...args),
      delete: (...args: unknown[]) => mockPrismaUserDelete(...args),
      update: vi.fn(),
    },
    team: { findFirst: (...args: unknown[]) => mockPrismaTeamFindFirst(...args) },
    membership: { findUnique: (...args: unknown[]) => mockPrismaMembershipFindUnique(...args) },
  };
  return { prisma: client, default: client };
});

const mockFindByEmailAndIncludeProfilesAndPassword = vi.fn();

vi.mock("@calcom/features/users/repositories/UserRepository", () => {
  return {
    UserRepository: vi.fn().mockImplementation(function () {
      return {
        findByEmailAndIncludeProfilesAndPassword: mockFindByEmailAndIncludeProfilesAndPassword,
      };
    }),
  };
});

vi.mock("./verifyPassword", () => ({
  verifyPassword: vi.fn(),
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@calcom/lib/server/PiiHasher", () => ({
  hashEmail: vi.fn((email: string) => `hashed_${email}`),
}));

vi.mock("@calcom/lib/totp", () => ({
  totpAuthenticatorCheck: vi.fn(),
}));

vi.mock("@calcom/lib/crypto", () => ({
  symmetricDecrypt: vi.fn(),
  symmetricEncrypt: vi.fn(),
}));

vi.mock("@calcom/lib/auth/isPasswordValid", () => ({
  isPasswordValid: vi.fn(),
}));

vi.mock("@calcom/lib/env", () => ({
  isENVDev: false,
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return {
    ...actual,
    IS_TEAM_BILLING_ENABLED: false,
    ENABLE_PROFILE_SWITCHER: false,
    WEBAPP_URL: "http://localhost:3000",
    WEBSITE_URL: "https://www.example.com",
    CONSOLE_URL: "https://console.example.com",
  };
});

vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock("@calcom/lib/safeStringify", () => ({
  safeStringify: vi.fn((obj) => JSON.stringify(obj)),
}));

const mockLinkAccount = vi.fn();

vi.mock("./next-auth-custom-adapter", () => ({
  default: vi.fn(() => ({
    linkAccount: (...args: unknown[]) => mockLinkAccount(...args),
  })),
}));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn().mockResolvedValue((key: string) => key),
}));

vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: {
    findAllProfilesForUserIncludingMovedUser: vi.fn(),
    findByUpIdWithAuth: vi.fn(),
  },
}));

// Additional mocks for signIn/JWT callback tests
const mockCredentialRepoFindFirst = vi.fn();
const mockCredentialRepoFindFirstByUserIdAndType = vi.fn();
const mockCredentialRepoCreate = vi.fn();
const mockBuildCredentialCreateData = vi.fn();
const mockUpdateProfilePhotoMicrosoft = vi.fn();
const mockUpdateProfilePhotoGoogle = vi.fn();
const mockGetIdentityProvider = vi.fn();
const mockWaitUntil = vi.fn();

vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: {
    findFirstByAppIdAndUserId: (...args: unknown[]) => mockCredentialRepoFindFirst(...args),
    findFirstByUserIdAndType: (...args: unknown[]) => mockCredentialRepoFindFirstByUserIdAndType(...args),
    create: (...args: unknown[]) => mockCredentialRepoCreate(...args),
  },
}));

vi.mock("@calcom/features/credentials/services/CredentialDataService", () => ({
  buildCredentialCreateData: (...args: unknown[]) => mockBuildCredentialCreateData(...args),
}));

vi.mock("@calcom/app-store/_utils/oauth/updateProfilePhotoMicrosoft", () => ({
  updateProfilePhotoMicrosoft: (...args: unknown[]) => mockUpdateProfilePhotoMicrosoft(...args),
}));

vi.mock("@calcom/app-store/_utils/oauth/updateProfilePhotoGoogle", () => ({
  updateProfilePhotoGoogle: (...args: unknown[]) => mockUpdateProfilePhotoGoogle(...args),
}));

vi.mock("@calcom/features/auth/lib/identityProviders", () => ({
  getIdentityProvider: (...args: unknown[]) => mockGetIdentityProvider(...args),
}));

vi.mock("@calcom/features/auth/lib/outlook", () => ({
  OUTLOOK_CLIENT_ID: "mock-client-id",
  OUTLOOK_CLIENT_SECRET: "mock-client-secret",
  OUTLOOK_LOGIN_ENABLED: true,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (...args: unknown[]) => mockWaitUntil(...args),
}));

vi.mock("@calcom/lib/default-cookies", () => ({
  defaultCookies: vi.fn(() => ({})),
}));

vi.mock("@calcom/lib/random", () => ({
  randomString: vi.fn(() => "abc123"),
}));

vi.mock("@calcom/lib/slugify", () => ({
  default: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
}));

vi.mock("@calcom/app-store/googlecalendar/lib/CalendarService", () => ({
  createGoogleCalendarServiceWithGoogleType: vi.fn(),
}));

vi.mock("googleapis-common", () => ({
  OAuth2Client: vi.fn(),
}));

vi.mock("@googleapis/calendar", () => ({
  calendar_v3: {
    Calendar: vi.fn(),
  },
}));

vi.mock("next-auth/jwt", () => ({
  encode: vi.fn(),
}));

vi.mock("./signJwt", () => ({
  default: vi.fn().mockResolvedValue("mock-jwt"),
}));

vi.mock("./dub", () => ({
  dub: { track: { lead: vi.fn() } },
}));

vi.mock("../signup/utils/getOrgUsernameFromEmail", () => ({
  getOrgUsernameFromEmail: vi.fn((email: string) => email.split("@")[0]),
}));

vi.mock("next-auth/providers/azure-ad", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn(() => ({ id: "credentials" })) }));
vi.mock("next-auth/providers/email", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));

type AuthModule = typeof import("./next-auth-options");
type Callbacks = NonNullable<ReturnType<AuthModule["getOptions"]>["callbacks"]>;
type SignInParams = Parameters<NonNullable<Callbacks["signIn"]>>[0];
type RedirectParams = Parameters<NonNullable<Callbacks["redirect"]>>[0];
type JwtParams = Parameters<NonNullable<Callbacks["jwt"]>>[0];
type SessionParams = Parameters<NonNullable<Callbacks["session"]>>[0];

const requestHeaders = (host: string) => ({
  get: (name: string) => (name === "host" ? host : null),
});

const credentialsParams: SignInParams = {
  user: { id: "1", email: "user@example.com" },
  account: { provider: "credentials", providerAccountId: "1", type: "credentials" },
  credentials: {},
};

const baseUrl = "http://localhost:3000";

async function getCallbacks(getRequestHeaders?: () => Pick<Headers, "get">) {
  const { getOptions } = await import("./next-auth-options");
  const options = getOptions({
    getDubId: () => undefined,
    getTrackingData: () => ({}),
    getRequestHeaders,
  });
  const callbacks = options.callbacks;
  if (!callbacks?.signIn || !callbacks.redirect || !callbacks.jwt || !callbacks.session) {
    throw new Error("callbacks missing");
  }
  return {
    signIn: callbacks.signIn,
    redirect: callbacks.redirect,
    jwt: callbacks.jwt,
    session: callbacks.session,
  };
}

const redirectParams = (url: string): RedirectParams => ({ url, baseUrl });

describe("next-auth options with organizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockGetOrgFromRequest.mockResolvedValue({ id: 7, domain: "acme.example.org" });
    mockCheckSignInDomain.mockResolvedValue({ kind: "allowed" });
    mockGetOrganizationOriginForUrl.mockResolvedValue(null);
    mockGetBaseUrl.mockResolvedValue("https://acme.example.org");
    mockFindDefaultOrganizationId.mockResolvedValue(null);
    mockAddMember.mockResolvedValue({ userId: 100, organizationId: 7, role: "MEMBER" });
    mockPrismaUserDelete.mockResolvedValue({ id: 100 });
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
    mockIsSessionInRequestOrganization.mockResolvedValue(true);
  });

  describe("flag off", () => {
    it("signs in without an organization lookup", async () => {
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(credentialsParams)).resolves.toBe(true);
      expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
      expect(mockCheckSignInDomain).not.toHaveBeenCalled();
    });

    it("signs in even when request headers are unavailable", async () => {
      const { signIn } = await getCallbacks();

      await expect(signIn(credentialsParams)).resolves.toBe(true);
    });

    it("redirect ignores the website, console and organization domains", async () => {
      mockGetOrganizationOriginForUrl.mockResolvedValue("https://acme.example.org");
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("https://www.example.com/x"))).resolves.toBe(baseUrl);
      await expect(redirect(redirectParams("https://console.example.com/x"))).resolves.toBe(baseUrl);
      await expect(redirect(redirectParams("https://acme.example.org/x"))).resolves.toBe(baseUrl);
      expect(mockGetOrganizationOriginForUrl).not.toHaveBeenCalled();
    });

    it("redirect keeps relative and same-domain URLs", async () => {
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("/bookings"))).resolves.toBe(`${baseUrl}/bookings`);
      await expect(redirect(redirectParams("http://localhost:3000/x"))).resolves.toBe(
        "http://localhost:3000/x"
      );
    });
  });

  describe("flag on, signIn", () => {
    beforeEach(() => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
    });

    it("allows sign-in when the domain check allows it", async () => {
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(credentialsParams)).resolves.toBe(true);
      expect(mockGetOrgFromRequest).toHaveBeenCalledTimes(1);
      expect(mockCheckSignInDomain).toHaveBeenCalledWith({
        email: "user@example.com",
        requestOrganizationId: 7,
        requestHost: "acme.example.org",
      });
    });

    it("passes a null organization id when the request has no organization", async () => {
      mockGetOrgFromRequest.mockResolvedValue(null);
      const { signIn } = await getCallbacks(() => requestHeaders("localhost:3000"));

      await signIn(credentialsParams);

      expect(mockCheckSignInDomain).toHaveBeenCalledWith(
        expect.objectContaining({ requestOrganizationId: null, requestHost: "localhost:3000" })
      );
    });

    it("returns the login URL when the user belongs to another organization domain", async () => {
      mockCheckSignInDomain.mockResolvedValue({
        kind: "redirect",
        loginUrl: "https://other.example.org/auth/login",
      });
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(credentialsParams)).resolves.toBe("https://other.example.org/auth/login");
    });

    it("returns the error URL when sign-in is refused", async () => {
      mockCheckSignInDomain.mockResolvedValue({
        kind: "refused",
        errorUrl: "https://acme.example.org/auth/error?error=wrong-organization-domain",
      });
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(credentialsParams)).resolves.toBe(
        "https://acme.example.org/auth/error?error=wrong-organization-domain"
      );
    });

    it("skips the check on the magic-link request step", async () => {
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await signIn({
        user: { id: "1", email: "user@example.com" },
        account: { provider: "email", providerAccountId: "user@example.com", type: "email" },
        email: { verificationRequest: true },
      });

      expect(result).toBe(true);
      expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
      expect(mockCheckSignInDomain).not.toHaveBeenCalled();
    });

    it("checks the domain when the magic link is used", async () => {
      mockCheckSignInDomain.mockResolvedValue({ kind: "refused", errorUrl: "https://x/auth/error" });
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await signIn({
        user: { id: "1", email: "user@example.com" },
        account: { provider: "email", providerAccountId: "user@example.com", type: "email" },
      });

      expect(result).toBe("https://x/auth/error");
    });

    it("passes a refused base result through without a lookup", async () => {
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await signIn({
        ...credentialsParams,
        account: { provider: "credentials", providerAccountId: "1", type: "oidc" },
      });

      expect(result).toBe(false);
      expect(mockCheckSignInDomain).not.toHaveBeenCalled();
    });

    it("passes a string base result through without a lookup", async () => {
      mockGetIdentityProvider.mockReturnValue(null);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await signIn({
        user: { id: "1", email: "user@example.com", name: "User" },
        account: { provider: "unknown", providerAccountId: "1", type: "oauth" },
      });

      expect(result).toBe("/auth/error?error=unknown-provider");
      expect(mockCheckSignInDomain).not.toHaveBeenCalled();
    });

    it("refuses sign-in when request headers are unavailable", async () => {
      const { signIn } = await getCallbacks();

      await expect(signIn(credentialsParams)).resolves.toBe(false);
      expect(mockCheckSignInDomain).not.toHaveBeenCalled();
    });

    it("propagates lookup errors", async () => {
      mockCheckSignInDomain.mockRejectedValue(new Error("db down"));
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(credentialsParams)).rejects.toThrow("db down");
    });
  });

  describe("flag on, redirect", () => {
    beforeEach(() => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
    });

    it("allows the website domain", async () => {
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("https://www.example.com/pricing"))).resolves.toBe(
        "https://www.example.com/pricing"
      );
    });

    it("allows the console domain", async () => {
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("https://console.example.com/x"))).resolves.toBe(
        "https://console.example.com/x"
      );
    });

    it("allows an organization origin", async () => {
      mockGetOrganizationOriginForUrl.mockResolvedValue("https://acme.example.org");
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("https://acme.example.org/bookings"))).resolves.toBe(
        "https://acme.example.org/bookings"
      );
      expect(mockGetOrganizationOriginForUrl).toHaveBeenCalledWith("https://acme.example.org/bookings");
    });

    it("falls back to baseUrl for an unknown host", async () => {
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("https://evil.example.net/x"))).resolves.toBe(baseUrl);
    });

    it("falls back to baseUrl when the organization origin does not match the URL origin", async () => {
      mockGetOrganizationOriginForUrl.mockResolvedValue("https://acme.example.org");
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("http://acme.example.org/x"))).resolves.toBe(baseUrl);
    });

    it("keeps relative URLs unchanged", async () => {
      const { redirect } = await getCallbacks();

      await expect(redirect(redirectParams("/bookings"))).resolves.toBe(`${baseUrl}/bookings`);
      expect(mockGetOrganizationOriginForUrl).not.toHaveBeenCalled();
    });
  });

  describe("jwt org.fullDomain", () => {
    const jwtParams = { token: { sub: "1", email: "user@example.com", upId: "usr_1" } } as JwtParams;

    beforeEach(async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        username: "user",
        name: "User",
        email: "user@example.com",
        role: "USER",
        locale: "en",
        movedToProfileId: null,
        teams: [],
      });
      mockPrismaMembershipFindUnique.mockResolvedValue({ role: "MEMBER" });
      const { ProfileRepository } = await import("@calcom/features/profile/repositories/ProfileRepository");
      vi.mocked(ProfileRepository.findAllProfilesForUserIncludingMovedUser).mockResolvedValue([
        { id: 1, upId: "usr_1" },
      ] as never);
      vi.mocked(ProfileRepository.findByUpIdWithAuth).mockResolvedValue({
        id: 1,
        username: "user",
        organization: { id: 42, name: "Acme", slug: "acme", logoUrl: null, isPlatform: false },
      } as never);
    });

    it("uses WEBAPP_URL without a lookup when the flag is off", async () => {
      const { jwt } = await getCallbacks();

      const token = await jwt(jwtParams);

      expect(token.org?.fullDomain).toBe("http://localhost:3000");
      expect(mockGetBaseUrl).not.toHaveBeenCalled();
    });

    it("uses the organization base URL when the flag is on", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      const { jwt } = await getCallbacks();

      const token = await jwt(jwtParams);

      expect(token.org?.fullDomain).toBe("https://acme.example.org");
      expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 42 });
    });
  });

  describe("new OAuth user organization", () => {
    const googleSignUpParams: SignInParams = {
      user: { id: "1", email: "new@acme.com", name: "New User" },
      account: { provider: "google", providerAccountId: "google-1", type: "oauth" },
      profile: { email: "new@acme.com", email_verified: true } as SignInParams["profile"],
    };

    const createdUserData = () => {
      const [args] = mockPrismaUserCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
      return args.data;
    };

    beforeEach(() => {
      mockGetIdentityProvider.mockReturnValue("GOOGLE");
      mockPrismaUserFindFirst.mockResolvedValue(null);
      mockPrismaTeamFindFirst.mockResolvedValue(null);
      mockPrismaUserCreate.mockResolvedValue({ id: 100, email: "new@acme.com", twoFactorEnabled: false });
    });

    it("joins the default organization with the flag off", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);

      expect(createdUserData()).toMatchObject({ organization: { connect: { id: 1 } } });
      expect(createdUserData()).not.toHaveProperty("teams");
      expect(createdUserData()).not.toHaveProperty("verified");
      expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    });

    it("sets no organization while the default organization does not exist", async () => {
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await signIn(googleSignUpParams);

      expect(createdUserData()).not.toHaveProperty("organization");
    });

    it("joins the request organization with the flag on", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await signIn(googleSignUpParams);

      expect(createdUserData()).toMatchObject({ organization: { connect: { id: 7 } } });
      expect(mockFindDefaultOrganizationId).not.toHaveBeenCalled();
    });

    it("falls back to the default organization when the request has no organization", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockGetOrgFromRequest.mockResolvedValue(null);
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("localhost:3000"));

      await signIn(googleSignUpParams);

      expect(createdUserData()).toMatchObject({ organization: { connect: { id: 1 } } });
    });

    it("falls back to the default organization when request headers are unavailable", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks();

      await signIn(googleSignUpParams);

      expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
      expect(createdUserData()).toMatchObject({ organization: { connect: { id: 1 } } });
    });

    it("keeps the autolinked organization with its verified membership", async () => {
      // ORGANIZATIONS_AUTOLINK is read when the module loads.
      vi.stubEnv("ORGANIZATIONS_AUTOLINK", "1");
      vi.resetModules();
      onTestFinished(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
      });
      mockPrismaTeamFindFirst.mockResolvedValue({ id: 55 });
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await signIn(googleSignUpParams);

      expect(createdUserData()).toMatchObject({
        verified: true,
        organization: { connect: { id: 55 } },
        teams: { create: { role: "MEMBER", accepted: true, team: { connect: { id: 55 } } } },
      });
      expect(mockFindDefaultOrganizationId).not.toHaveBeenCalled();
    });

    it("does not add another membership for an autolinked user with the flag on", async () => {
      vi.stubEnv("ORGANIZATIONS_AUTOLINK", "1");
      vi.resetModules();
      onTestFinished(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
      });
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockPrismaTeamFindFirst.mockResolvedValue({ id: 55 });
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);

      expect(createdUserData()).toMatchObject({ organization: { connect: { id: 55 } } });
      expect(mockAddMember).not.toHaveBeenCalled();
      expect(mockLinkAccount).toHaveBeenCalledTimes(1);
    });

    it("adds the default organization membership with the flag off", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);

      expect(mockAddMember).toHaveBeenCalledWith({ organizationId: 1, userId: 100, role: "MEMBER" });
      expect(mockAddMember.mock.invocationCallOrder[0]).toBeLessThan(
        mockLinkAccount.mock.invocationCallOrder[0]
      );
    });

    it("does not add an organization membership while the default organization does not exist", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(null);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);

      expect(mockAddMember).not.toHaveBeenCalled();
      expect(mockLinkAccount).toHaveBeenCalledTimes(1);
    });

    it("deletes the new user when adding the default organization membership fails with the flag off", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      mockAddMember.mockRejectedValue(new Error("username taken"));
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe("/auth/error?error=user-creation-error");

      expect(mockPrismaUserDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 100 } }));
      expect(mockLinkAccount).not.toHaveBeenCalled();
    });

    it("accepts pending invites for the request organization after linking the account with the flag on", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);

      expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
        userId: 100,
        email: "new@acme.com",
        organizationId: 7,
      });
      expect(mockLinkAccount.mock.invocationCallOrder[0]).toBeLessThan(
        mockAcceptPendingInvitesOnSignup.mock.invocationCallOrder[0]
      );
    });

    it("accepts pending invites for the default organization with the flag off", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await signIn(googleSignUpParams);

      expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
        userId: 100,
        email: "new@acme.com",
        organizationId: 1,
      });
      expect(mockLinkAccount.mock.invocationCallOrder[0]).toBeLessThan(
        mockAcceptPendingInvitesOnSignup.mock.invocationCallOrder[0]
      );
    });

    it("accepts pending invites without an organization when no default organization exists", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(null);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await signIn(googleSignUpParams);

      expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
        userId: 100,
        email: "new@acme.com",
        organizationId: null,
      });
    });

    it("still signs in when accepting pending invites fails", async () => {
      mockFindDefaultOrganizationId.mockResolvedValue(1);
      mockAcceptPendingInvitesOnSignup.mockRejectedValue(new Error("db down"));
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);
      expect(mockLinkAccount).toHaveBeenCalledTimes(1);
    });

    it("adds the organization membership before linking the account with the flag on", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe(true);

      expect(mockAddMember).toHaveBeenCalledWith({ organizationId: 7, userId: 100, role: "MEMBER" });
      expect(mockAddMember.mock.invocationCallOrder[0]).toBeLessThan(
        mockLinkAccount.mock.invocationCallOrder[0]
      );
    });

    it("adds the organization membership for a new Azure AD user with the flag on", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockGetIdentityProvider.mockReturnValue("AZUREAD");
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await signIn({
        user: { id: "1", email: "new@acme.com", name: "New User" },
        account: { provider: "azure-ad", providerAccountId: "azure-1", type: "oauth" },
        profile: { email: "new@acme.com", xms_edov: true } as SignInParams["profile"],
      });

      expect(result).toBe(true);
      expect(mockAddMember).toHaveBeenCalledWith({ organizationId: 7, userId: 100, role: "MEMBER" });
      expect(mockAddMember.mock.invocationCallOrder[0]).toBeLessThan(
        mockLinkAccount.mock.invocationCallOrder[0]
      );
    });

    it("deletes the new user and refuses sign-in when adding the membership fails", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockAddMember.mockRejectedValue(new Error("username taken"));
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe("/auth/error?error=user-creation-error");

      expect(mockPrismaUserDelete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 100 } }));
      expect(mockLinkAccount).not.toHaveBeenCalled();
    });

    it("refuses sign-in when deleting the new user also fails", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockAddMember.mockRejectedValue(new Error("username taken"));
      mockPrismaUserDelete.mockRejectedValue(new Error("db down"));
      const { signIn } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(signIn(googleSignUpParams)).resolves.toBe("/auth/error?error=user-creation-error");
      expect(mockLinkAccount).not.toHaveBeenCalled();
    });
  });

  describe("session organization check", () => {
    const baseSessionParams = (tokenId: unknown = 1) =>
      ({
        session: { expires: "2099-01-01T00:00:00.000Z", user: { email: "user@example.com" } },
        token: { sub: "1", id: tokenId, email: "user@example.com" },
        user: undefined,
      }) as unknown as SessionParams;

    it("returns the base session without the check when the flag is off", async () => {
      const { session } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await session(baseSessionParams());

      expect(result).toMatchObject({ expires: "2099-01-01T00:00:00.000Z", user: { id: 1 } });
      expect(mockIsSessionInRequestOrganization).not.toHaveBeenCalled();
    });

    it("returns the session when it belongs to the request organization", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      const { session } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await session(baseSessionParams());

      expect(result).toMatchObject({ expires: "2099-01-01T00:00:00.000Z", user: { id: 1 } });
      expect(mockIsSessionInRequestOrganization).toHaveBeenCalledWith({
        userId: 1,
        headers: expect.anything(),
      });
    });

    it("returns a signed-out session when it does not belong to the request organization", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockIsSessionInRequestOrganization.mockResolvedValue(false);
      const { session } = await getCallbacks(() => requestHeaders("other.example.org"));

      await expect(session(baseSessionParams())).resolves.toEqual({});
    });

    it("returns a signed-out session instead of rejecting when the check throws", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      mockIsSessionInRequestOrganization.mockRejectedValue(new Error("db down"));
      const { session } = await getCallbacks(() => requestHeaders("acme.example.org"));

      await expect(session(baseSessionParams())).resolves.toEqual({});
    });

    it("returns a signed-out session when request headers are unavailable", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      const { session } = await getCallbacks();

      await expect(session(baseSessionParams())).resolves.toEqual({});
      expect(mockIsSessionInRequestOrganization).not.toHaveBeenCalled();
    });

    it("returns the base session without the check when the token has no numeric user id", async () => {
      mockIsOrganizationsEnabled.mockReturnValue(true);
      const { session } = await getCallbacks(() => requestHeaders("acme.example.org"));

      const result = await session(baseSessionParams("1"));

      expect(result).toMatchObject({ expires: "2099-01-01T00:00:00.000Z" });
      expect(mockIsSessionInRequestOrganization).not.toHaveBeenCalled();
    });
  });
});
