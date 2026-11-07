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
const mockFindDefaultOrganizationId: Mock = vi.fn();

const DEFAULT_ORG_ID = 99;

type UsernameStatus = {
  statusCode: 200 | 402 | 418;
  requestedUserName: string;
  json: { available: boolean; premium: boolean };
};

type InnerHandler = (body: Record<string, string>, status: UsernameStatus) => Promise<MockResponse>;

var mockCapturedHandler: InnerHandler | null;

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
  default: { getSubLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }) },
}));
vi.mock("@calcom/lib/auth/hashPassword", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@calcom/lib/constants", () => ({ WEBAPP_URL: "http://localhost:3000" }));
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
  usernameHandler: (handler: InnerHandler) => {
    mockCapturedHandler = handler;
    return handler;
  },
}));
vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  findDefaultOrganizationId: (...args: unknown[]) => mockFindDefaultOrganizationId(...args),
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
import { runP2002TestSuite } from "@calcom/features/auth/signup/handlers/__tests__/p2002.test-suite";

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
  mockFindDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
  prismaMock.team.findUnique.mockResolvedValue(createMockTeam() as never);
  prismaMock.verificationToken.delete.mockResolvedValue({} as never);
});

describe("calcomHandler – team invite materialization", () => {
  it("accepts pending team invites after a plain signup", async () => {
    vi.clearAllMocks();
    resetPrismaMock();
    mockFindDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
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

  it("accepts pending invites without an organization while the default organization does not exist", async () => {
    vi.clearAllMocks();
    resetPrismaMock();
    mockFindDefaultOrganizationId.mockResolvedValue(null);
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
      organizationId: null,
    });
  });

  it("still signs up when invite materialization fails", async () => {
    vi.clearAllMocks();
    resetPrismaMock();
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
  function setup(defaultOrgId: number | null): void {
    vi.clearAllMocks();
    resetPrismaMock();
    mockFindDefaultOrganizationId.mockResolvedValue(defaultOrgId);
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
      expect.objectContaining({ data: expect.objectContaining({ organizationId: DEFAULT_ORG_ID }) })
    );
  });

  it("leaves a plain signup without an organization when no default organization exists", async () => {
    setup(null);

    const response = await callHandler(createSignupBody());

    expect(response.status).toBe(201);
    const createArgs = prismaMock.user.create.mock.calls[0][0];
    expect(createArgs.data).not.toHaveProperty("organizationId");
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

  it("leaves a non-org team invitee without an organization when no default organization exists", async () => {
    setup(null);
    prismaMock.team.findUnique.mockResolvedValue(createMockTeam({ isOrganization: false }) as never);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(prismaMock.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ organizationId: null }) })
    );
  });

  it("keeps an organization invitee in the inviting organization", async () => {
    setup(DEFAULT_ORG_ID);
    prismaMock.team.findUnique.mockResolvedValue(createMockTeam({ id: 7, isOrganization: true }) as never);

    const response = await callHandler(createSignupBody({ token: "token" }));

    expect(response.status).toBe(201);
    expect(mockFindDefaultOrganizationId).not.toHaveBeenCalled();
    expect(prismaMock.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ organizationId: 7 }) })
    );
  });
});
