import type { MockResponse } from "@calcom/features/auth/signup/handlers/__tests__/mocks/next.mocks";
import {
  prismaMock,
  resetPrismaMock,
} from "@calcom/features/auth/signup/handlers/__tests__/mocks/prisma.mocks";
import type { SignupBody } from "@calcom/features/auth/signup/handlers/__tests__/mocks/signup.factories";
import {
  createMockFoundToken,
  createMockTeam,
  createSignupBody,
} from "@calcom/features/auth/signup/handlers/__tests__/mocks/signup.factories";
import type { Mock } from "vitest";
import { vi } from "vitest";

const mockFindTokenByToken: Mock = vi.fn();
const mockValidateAndGetCorrectedUsernameForTeam: Mock = vi.fn();
const mockAcceptPendingInvitesOnSignup: Mock = vi.fn();
const mockRequireDefaultOrganizationId: Mock = vi.fn();
const mockIsOrganizationsEnabled: Mock = vi.fn().mockReturnValue(false);
const mockAddMember: Mock = vi.fn();
const mockGetOrgFromRequest: Mock = vi.fn();
const mockLogError: Mock = vi.fn();

const DEFAULT_ORG_ID = 99;

type UsernameStatus = {
  statusCode: 200 | 402 | 418;
  requestedUserName: string;
  json: { available: boolean; premium: boolean };
};

type InnerHandler = (body: Record<string, string>, status: UsernameStatus) => Promise<MockResponse>;

type CapturedOptions = { resolveOrganizationId?: (body: Record<string, string>) => Promise<number | null> };

var mockCapturedHandler: InnerHandler | null;
var mockCapturedOptions: CapturedOptions | undefined;

vi.mock("next/server", async () => {
  const { createNextServerMock } = await import(
    "@calcom/features/auth/signup/handlers/__tests__/mocks/next.mocks"
  );
  return createNextServerMock();
});
vi.mock("next/headers", async () => {
  const { createNextHeadersMock } = await import(
    "@calcom/features/auth/signup/handlers/__tests__/mocks/next.mocks"
  );
  return createNextHeadersMock();
});
vi.mock("@calcom/prisma", async () => {
  const { createPrismaMock } = await import(
    "@calcom/features/auth/signup/handlers/__tests__/mocks/prisma.mocks"
  );
  return createPrismaMock();
});
vi.mock("@calcom/prisma/client", async () => {
  const { createPrismaMock } = await import(
    "@calcom/features/auth/signup/handlers/__tests__/mocks/prisma.mocks"
  );
  return createPrismaMock();
});
vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: () => ({
      warn: vi.fn(),
      error: (...args: unknown[]) => mockLogError(...args),
      debug: vi.fn(),
      info: vi.fn(),
    }),
  },
}));
vi.mock("@calcom/lib/auth/hashPassword", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@calcom/lib/constants", () => ({
  WEBAPP_URL: "http://localhost:3000",
  WEBAPP_URL_FOR_OAUTH: "http://localhost:3000",
  ALLOWED_HOSTNAMES: [],
}));
vi.mock("@calcom/lib/tracking", () => ({ getTrackingFromCookies: vi.fn().mockReturnValue({}) }));
vi.mock("@calcom/app-store/stripepayment/lib/utils", () => ({ getPremiumMonthlyPlanPriceId: vi.fn() }));
vi.mock("@calcom/features/auth/lib/getLocaleFromRequest", () => ({
  getLocaleFromRequest: vi.fn().mockResolvedValue("en"),
}));
vi.mock("@calcom/features/auth/lib/verifyEmail", () => ({ sendEmailVerification: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/createOrUpdateMemberships", () => ({
  createOrUpdateMemberships: vi.fn(),
}));
vi.mock("@calcom/features/auth/signup/utils/prefillAvatar", () => ({ prefillAvatar: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/validateUsername", () => ({
  validateAndGetCorrectedUsernameAndEmail: vi.fn().mockResolvedValue({ isValid: true, username: "testuser" }),
}));
vi.mock("@calcom/features/watchlist/lib/telemetry", () => ({ sentrySpan: {} }));
vi.mock("@calcom/features/watchlist/operations/check-if-email-in-watchlist.controller", () => ({
  checkIfEmailIsBlockedInWatchlistController: vi.fn().mockResolvedValue(false),
}));
vi.mock("@calcom/features/di/containers/FeatureRepository", () => ({
  getFeatureRepository: vi.fn().mockReturnValue({
    checkIfFeatureIsEnabledGlobally: vi.fn().mockResolvedValue(false),
  }),
}));
vi.mock("@calcom/features/watchlist/lib/repository/GlobalWatchlistRepository", () => {
  return {
    GlobalWatchlistRepository: class {
      findBlockedEmail = vi.fn().mockResolvedValue(null);
      createEntry = vi.fn().mockResolvedValue({});
    },
  };
});
vi.mock("@calcom/features/watchlist/lib/utils/normalization", () => ({
  normalizeEmail: vi.fn((e: string) => e.toLowerCase()),
}));
vi.mock("@calcom/web/lib/buildLegacyCtx", () => ({ buildLegacyRequest: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/organization", () => ({ joinAnyChildTeamOnOrgInvite: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/token", () => ({
  findTokenByToken: (...args: unknown[]) => mockFindTokenByToken(...args),
  throwIfTokenExpired: vi.fn(),
  validateAndGetCorrectedUsernameForTeam: (...args: unknown[]) =>
    mockValidateAndGetCorrectedUsernameForTeam(...args),
}));

// Capture inner handler from usernameHandler wrapper
vi.mock("@calcom/lib/server/username", () => ({
  usernameHandler: (handler: InnerHandler, options?: CapturedOptions) => {
    mockCapturedHandler = handler;
    mockCapturedOptions = options;
    return handler;
  },
}));
vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: () => mockIsOrganizationsEnabled(),
}));
vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember: mockAddMember }),
}));
vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  requireDefaultOrganizationId: (...args: unknown[]) => mockRequireDefaultOrganizationId(...args),
}));
vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: (...args: unknown[]) => mockGetOrgFromRequest(...args),
}));
vi.mock("@calcom/features/membership/services/TeamMembersService", () => ({
  TeamMembersService: class {
    acceptPendingInvitesOnSignup(...args: unknown[]) {
      return mockAcceptPendingInvitesOnSignup(...args);
    }
  },
}));

// Import after mocks
import { describe, expect, it } from "vitest";

import "./calcomSignupHandler";
import { SIGNUP_ERROR_CODES } from "@calcom/features/auth/signup/constants";
import { runP2002TestSuite } from "@calcom/features/auth/signup/handlers/__tests__/p2002.test-suite";
import { createOrUpdateMemberships } from "@calcom/features/auth/signup/utils/createOrUpdateMemberships";
import { validateAndGetCorrectedUsernameAndEmail } from "@calcom/features/auth/signup/utils/validateUsername";
import { ErrorWithCode } from "@calcom/lib/errors";

function callHandler(body: SignupBody): Promise<MockResponse> {
  if (!mockCapturedHandler) throw new Error("Handler not captured");
  return mockCapturedHandler(body as unknown as Record<string, string>, {
    statusCode: 200,
    requestedUserName: body.username || "testuser",
    json: { available: true, premium: false },
  });
}

runP2002TestSuite("calcomHandler", callHandler, () => {
  vi.clearAllMocks();
  resetPrismaMock();
  mockFindTokenByToken.mockResolvedValue(createMockFoundToken());
  mockValidateAndGetCorrectedUsernameForTeam.mockResolvedValue("testuser");
  mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
  mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
  prismaMock.team.findUnique.mockResolvedValue(createMockTeam() as never);
  prismaMock.verificationToken.delete.mockResolvedValue({} as never);
});

describe("calcomHandler – team invite materialization", () => {
  it("accepts pending team invites after a plain signup", async () => {
    vi.clearAllMocks();
    resetPrismaMock();
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "accepted", teamIds: [1] });
    prismaMock.user.create.mockResolvedValue({ id: 42 } as never);

    const response = await callHandler({
      email: "invited@example.com",
      password: "ValidPassword123!",
      username: "invited",
      language: "en",
    });

    expect(response.status).toBe(201);
    expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
      userId: 42,
      email: "invited@example.com",
      organizationId: DEFAULT_ORG_ID,
    });
  });

  it("still signs up when invite materialization fails", async () => {
    vi.clearAllMocks();
    resetPrismaMock();
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
    mockAcceptPendingInvitesOnSignup.mockRejectedValue(new Error("db down"));
    prismaMock.user.create.mockResolvedValue({ id: 42 } as never);

    const response = await callHandler({
      email: "invited@example.com",
      password: "ValidPassword123!",
      username: "invited",
      language: "en",
    });

    expect(response.status).toBe(201);
  });
});

describe("calcomHandler – default organization", () => {
  function setup(defaultOrgId: number): void {
    vi.clearAllMocks();
    resetPrismaMock();
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockRequireDefaultOrganizationId.mockResolvedValue(defaultOrgId);
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
    mockFindTokenByToken.mockResolvedValue(createMockFoundToken());
    mockValidateAndGetCorrectedUsernameForTeam.mockResolvedValue("testuser");
    prismaMock.user.create.mockResolvedValue({ id: 42 } as never);
    prismaMock.user.upsert.mockResolvedValue({ id: 42 } as never);
    prismaMock.verificationToken.delete.mockResolvedValue({} as never);
  }

  it("places a plain signup in the default organization", async () => {
    setup(DEFAULT_ORG_ID);

    const response = await callHandler(createSignupBody());

    expect(response.status).toBe(201);
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organization: { connect: { id: DEFAULT_ORG_ID } } }),
      })
    );
  });

  it("creates no user when no default organization exists", async () => {
    setup(DEFAULT_ORG_ID);
    mockRequireDefaultOrganizationId.mockRejectedValue(new Error("No default organization"));

    await expect(callHandler(createSignupBody())).rejects.toThrow("No default organization");
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("places a non-org team invitee in the default organization", async () => {
    setup(DEFAULT_ORG_ID);
    prismaMock.team.findUnique.mockResolvedValue(createMockTeam({ isOrganization: false }) as never);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(prismaMock.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ organizationId: DEFAULT_ORG_ID }) })
    );
  });

  it("keeps an organization invitee in the inviting organization", async () => {
    setup(DEFAULT_ORG_ID);
    prismaMock.team.findUnique.mockResolvedValue(createMockTeam({ id: 7, isOrganization: true }) as never);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
    expect(prismaMock.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ organizationId: 7 }) })
    );
  });
});

describe("calcomHandler – organization membership", () => {
  const plainSignup = {
    email: "new@example.com",
    password: "ValidPassword123!",
    username: "testuser",
    language: "en",
  };

  function setup(): void {
    vi.clearAllMocks();
    resetPrismaMock();
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
    mockAddMember.mockResolvedValue(undefined);
    prismaMock.user.create.mockResolvedValue({ id: 42 } as never);
    prismaMock.user.deleteMany.mockResolvedValue({ count: 1 } as never);
  }

  it("adds a plain signup to the default organization as MEMBER", async () => {
    setup();

    const response = await callHandler(plainSignup);

    expect(response.status).toBe(201);
    expect(mockAddMember).toHaveBeenCalledWith({
      organizationId: DEFAULT_ORG_ID,
      userId: 42,
      role: "MEMBER",
    });
    expect(prismaMock.user.deleteMany).not.toHaveBeenCalled();
  });

  it("skips the membership for a premium username awaiting payment", async () => {
    setup();
    if (!mockCapturedHandler) throw new Error("Handler not captured");

    const response = await mockCapturedHandler(plainSignup, {
      statusCode: 402,
      requestedUserName: "testuser",
      json: { available: true, premium: true },
    });

    expect(response.status).toBe(201);
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ username: null }) })
    );
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("returns 409 and removes the user when the membership conflicts", async () => {
    setup();
    mockAddMember.mockRejectedValue(
      ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
    );

    const response = await callHandler(plainSignup);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS });
    expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [42] } } });
    expect(mockAcceptPendingInvitesOnSignup).not.toHaveBeenCalled();
  });

  it("still returns 409 and logs when removing the user after a conflict fails", async () => {
    setup();
    mockAddMember.mockRejectedValue(
      ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
    );
    prismaMock.user.deleteMany.mockRejectedValue(new Error("db down"));

    const response = await callHandler(plainSignup);

    expect(response.status).toBe(409);
    expect(mockLogError).toHaveBeenCalledWith(
      "Failed to remove a user whose organization membership could not be created",
      { userId: 42, organizationId: DEFAULT_ORG_ID }
    );
  });

  it("rethrows membership errors other than conflicts after removing the user", async () => {
    setup();
    mockAddMember.mockRejectedValue(ErrorWithCode.Factory.NotFound("Organization not found"));

    await expect(callHandler(plainSignup)).rejects.toThrow("Organization not found");
    expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [42] } } });
  });

  it("scopes username validation to the host organization with the flag on", async () => {
    setup();
    mockIsOrganizationsEnabled.mockReturnValue(true);
    mockGetOrgFromRequest.mockResolvedValue({ id: 7 });

    await callHandler(plainSignup);

    expect(validateAndGetCorrectedUsernameAndEmail).toHaveBeenCalledWith(
      expect.objectContaining({ usernameOrganizationId: 7 })
    );
  });

  it("keeps username validation global with the flag off", async () => {
    setup();

    await callHandler(plainSignup);

    expect(validateAndGetCorrectedUsernameAndEmail).toHaveBeenCalledWith(
      expect.not.objectContaining({ usernameOrganizationId: expect.anything() })
    );
  });
});

describe("calcomHandler – username availability organization", () => {
  function resolveOrganizationId(body: Record<string, string>): Promise<number | null> {
    const resolve = mockCapturedOptions?.resolveOrganizationId;
    if (!resolve) throw new Error("resolveOrganizationId not captured");
    return resolve(body);
  }

  function setup(orgsEnabled: boolean): void {
    vi.clearAllMocks();
    mockIsOrganizationsEnabled.mockReturnValue(orgsEnabled);
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
  }

  it("checks globally with the flag off", async () => {
    setup(false);

    expect(await resolveOrganizationId({ username: "testuser" })).toBeNull();
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
  });

  it("checks within the host organization with the flag on", async () => {
    setup(true);
    mockGetOrgFromRequest.mockResolvedValue({ id: 7 });

    expect(await resolveOrganizationId({ username: "testuser" })).toBe(7);
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
  });

  it("returns null with the flag on when the host has no organization", async () => {
    setup(true);
    mockGetOrgFromRequest.mockResolvedValue(null);

    expect(await resolveOrganizationId({ username: "testuser" })).toBeNull();
  });

  it("checks globally for an invitee with the flag on", async () => {
    setup(true);

    expect(await resolveOrganizationId({ username: "testuser", token: "invite-token" })).toBeNull();
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
  });
});

describe("calcomHandler – host organization", () => {
  const HOST_ORG_ID = 7;
  const teamOutsideAnyOrg = { id: 3, isOrganization: false, parent: null, parentId: null };

  function setup(orgsEnabled: boolean): void {
    vi.clearAllMocks();
    resetPrismaMock();
    mockIsOrganizationsEnabled.mockReturnValue(orgsEnabled);
    mockGetOrgFromRequest.mockResolvedValue({ id: HOST_ORG_ID });
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
    mockAddMember.mockResolvedValue(undefined);
    mockFindTokenByToken.mockResolvedValue(createMockFoundToken({ teamId: teamOutsideAnyOrg.id }));
    mockValidateAndGetCorrectedUsernameForTeam.mockResolvedValue("testuser");
    prismaMock.user.create.mockResolvedValue({ id: 42 } as never);
    prismaMock.user.upsert.mockResolvedValue({ id: 42 } as never);
    prismaMock.team.findUnique.mockResolvedValue(teamOutsideAnyOrg as never);
    prismaMock.verificationToken.delete.mockResolvedValue({} as never);
  }

  it("places a plain signup in the host organization with the flag on", async () => {
    setup(true);

    const response = await callHandler(createSignupBody());

    expect(response.status).toBe(201);
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organization: { connect: { id: HOST_ORG_ID } } }),
      })
    );
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: HOST_ORG_ID, userId: 42, role: "MEMBER" });
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
  });

  it("returns 404 and creates no user when the host has no organization", async () => {
    setup(true);
    mockGetOrgFromRequest.mockResolvedValue(null);

    const response = await callHandler(createSignupBody());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Organization not found" });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("places an invitee of a team outside any org in the host organization", async () => {
    setup(true);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(prismaMock.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ organizationId: HOST_ORG_ID }) })
    );
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: HOST_ORG_ID, userId: 42, role: "MEMBER" });
    const membershipsOrder = vi.mocked(createOrUpdateMemberships).mock.invocationCallOrder[0];
    const addMemberOrder = mockAddMember.mock.invocationCallOrder[0];
    expect(membershipsOrder).toBeLessThan(addMemberOrder);
  });

  it("returns 404 for an invitee of a team outside any org when the host has no organization", async () => {
    setup(true);
    mockGetOrgFromRequest.mockResolvedValue(null);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Organization not found" });
    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
  });

  it("returns 409 and keeps the token when the host organization membership conflicts", async () => {
    setup(true);
    mockAddMember.mockRejectedValue(
      ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
    );

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS });
    expect(prismaMock.verificationToken.delete).not.toHaveBeenCalled();
  });

  it("does not add an organization invitee to the host organization", async () => {
    setup(true);
    prismaMock.team.findUnique.mockResolvedValue(createMockTeam({ id: 5, isOrganization: true }) as never);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("skips the host organization membership for a premium username awaiting payment", async () => {
    setup(true);
    if (!mockCapturedHandler) throw new Error("Handler not captured");

    const response = await mockCapturedHandler(
      createSignupBody({ token: "token" }) as unknown as Record<string, string>,
      {
        statusCode: 402,
        requestedUserName: "testuser",
        json: { available: true, premium: true },
      }
    );

    expect(response.status).toBe(201);
    expect(prismaMock.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ organizationId: HOST_ORG_ID }) })
    );
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("adds an invitee of a team outside any org to the default organization with the flag off", async () => {
    setup(false);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith({
      organizationId: DEFAULT_ORG_ID,
      userId: 42,
      role: "MEMBER",
    });
  });
});
