import {
  prismaMock,
  resetPrismaMock,
} from "@calcom/features/auth/signup/handlers/__tests__/mocks/prisma.mocks";
import type { SignupBody } from "@calcom/features/auth/signup/handlers/__tests__/mocks/signup.factories";
import {
  createMockFoundToken,
  createMockTeam,
} from "@calcom/features/auth/signup/handlers/__tests__/mocks/signup.factories";
import type { Mock } from "vitest";
import { vi } from "vitest";

const mockFindTokenByToken: Mock = vi.fn();
const mockValidateAndGetCorrectedUsernameForTeam: Mock = vi.fn();
const mockAcceptPendingInvitesOnSignup: Mock = vi.fn();
const mockIsOrganizationsEnabled: Mock = vi.fn().mockReturnValue(false);
const mockGetOrgFromRequest: Mock = vi.fn();
const mockAddMember: Mock = vi.fn();
const mockFindDefaultOrganizationId: Mock = vi.fn().mockResolvedValue(null);

vi.mock("next/server", async () => {
  const { createNextServerMock } = await import(
    "@calcom/features/auth/signup/handlers/__tests__/mocks/next.mocks"
  );
  return createNextServerMock();
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
    getSubLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
    error: vi.fn(),
  },
}));
vi.mock("@calcom/features/membership/services/TeamMembersService", () => ({
  TeamMembersService: class {
    acceptPendingInvitesOnSignup(...args: unknown[]) {
      return mockAcceptPendingInvitesOnSignup(...args);
    }
  },
}));
vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: () => mockIsOrganizationsEnabled(),
}));
vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: (...args: unknown[]) => mockGetOrgFromRequest(...args),
}));
vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  findDefaultOrganizationId: () => mockFindDefaultOrganizationId(),
}));
vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember: mockAddMember }),
}));
vi.mock("@calcom/lib/auth/hashPassword", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@calcom/lib/slugify", () => ({ default: vi.fn((s: string) => s.toLowerCase()) }));
vi.mock("@calcom/lib/constants", () => ({ IS_PREMIUM_USERNAME_ENABLED: false }));
vi.mock("@calcom/lib/server/username", () => ({
  isUsernameReservedDueToMigration: vi.fn().mockResolvedValue(false),
}));
vi.mock("@calcom/features/auth/lib/verifyEmail", () => ({ sendEmailVerification: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/createOrUpdateMemberships", () => ({
  createOrUpdateMemberships: vi.fn(),
}));
vi.mock("@calcom/features/auth/signup/utils/validateUsername", () => ({
  validateAndGetCorrectedUsernameAndEmail: vi.fn().mockResolvedValue({ isValid: true, username: "testuser" }),
}));
vi.mock("@calcom/features/auth/signup/utils/organization", () => ({ joinAnyChildTeamOnOrgInvite: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/prefillAvatar", () => ({ prefillAvatar: vi.fn() }));
vi.mock("@calcom/features/auth/signup/utils/token", () => ({
  findTokenByToken: (...args: unknown[]) => mockFindTokenByToken(...args),
  throwIfTokenExpired: vi.fn(),
  validateAndGetCorrectedUsernameForTeam: (...args: unknown[]) =>
    mockValidateAndGetCorrectedUsernameForTeam(...args),
}));

import { SIGNUP_ERROR_CODES } from "@calcom/features/auth/signup/constants";
import { runP2002TestSuite } from "@calcom/features/auth/signup/handlers/__tests__/p2002.test-suite";
import { createOrUpdateMemberships } from "@calcom/features/auth/signup/utils/createOrUpdateMemberships";
import { joinAnyChildTeamOnOrgInvite } from "@calcom/features/auth/signup/utils/organization";
import { validateAndGetCorrectedUsernameAndEmail } from "@calcom/features/auth/signup/utils/validateUsername";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { isUsernameReservedDueToMigration } from "@calcom/lib/server/username";
// Import after mocks
import { beforeEach, describe, expect, it } from "vitest";
import handler from "./selfHostedHandler";

function callHandler(body: SignupBody): ReturnType<typeof handler> {
  return handler(body as unknown as Record<string, string>, new Headers());
}

runP2002TestSuite("selfHostedHandler", callHandler, () => {
  vi.clearAllMocks();
  resetPrismaMock();
  mockFindTokenByToken.mockResolvedValue(createMockFoundToken());
  mockValidateAndGetCorrectedUsernameForTeam.mockResolvedValue("testuser");
  mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
  prismaMock.team.findUnique.mockResolvedValue(createMockTeam() as never);
  prismaMock.verificationToken.delete.mockResolvedValue({} as never);
});

describe("selfHostedHandler – team invite materialization", () => {
  it("accepts pending team invites after a plain signup", async () => {
    vi.clearAllMocks();
    resetPrismaMock();
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
      organizationId: undefined,
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

describe("selfHostedHandler – organizations", () => {
  const hostOrg = { id: 7, slug: "acme", name: "Acme" };
  const defaultOrgId = 1;
  const signupBody = {
    email: "new@example.com",
    password: "ValidPassword123!",
    username: "newuser",
    language: "en",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMock();
    mockIsOrganizationsEnabled.mockReturnValue(true);
    mockGetOrgFromRequest.mockResolvedValue(hostOrg);
    mockFindDefaultOrganizationId.mockResolvedValue(defaultOrgId);
    mockAddMember.mockResolvedValue({ userId: 42, organizationId: hostOrg.id, role: "MEMBER" });
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "no-invites", teamIds: [] });
    mockFindTokenByToken.mockResolvedValue(createMockFoundToken());
    mockValidateAndGetCorrectedUsernameForTeam.mockResolvedValue("newuser");
    prismaMock.user.create.mockResolvedValue({ id: 42 } as never);
    prismaMock.user.upsert.mockResolvedValue({ id: 42 } as never);
    prismaMock.user.findFirst.mockResolvedValue(null as never);
    prismaMock.verificationToken.delete.mockResolvedValue({} as never);
  });

  function lastCreatedOrganizationId(): unknown {
    const [args] = prismaMock.user.create.mock.calls[0] as [{ data: { organizationId?: number } }];
    return args.data.organizationId ?? null;
  }

  function lastUpsertedOrganizationId(): unknown {
    const [args] = prismaMock.user.upsert.mock.calls[0] as [{ create: { organizationId: number | null } }];
    return args.create.organizationId;
  }

  it("joins the default org with global username validation when the flag is off", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);

    const response = await callHandler(signupBody);

    expect(response.status).toBe(201);
    expect(lastCreatedOrganizationId()).toBe(defaultOrgId);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: defaultOrgId, userId: 42, role: "MEMBER" });
    expect(validateAndGetCorrectedUsernameAndEmail).toHaveBeenCalledWith({
      username: "newuser",
      email: "new@example.com",
      isSignup: true,
    });
    expect(isUsernameReservedDueToMigration).toHaveBeenCalled();
  });

  it("returns 409 when the default org membership conflicts with the flag off", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockAddMember.mockRejectedValue(
      ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
    );

    const response = await callHandler(signupBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS });
  });

  it("rejects a migration-reserved username with the flag off when the default org exists", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    vi.mocked(isUsernameReservedDueToMigration).mockResolvedValueOnce(true);

    const response = await callHandler(signupBody);

    expect(response.status).toBe(409);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("keeps the legacy global signup when the flag is off and no default org exists yet", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockFindDefaultOrganizationId.mockResolvedValue(null);

    const response = await callHandler(signupBody);

    expect(response.status).toBe(201);
    expect(lastCreatedOrganizationId()).toBeNull();
    expect(mockAddMember).not.toHaveBeenCalled();
    expect(isUsernameReservedDueToMigration).toHaveBeenCalled();
  });

  it("joins the default org when the inviting team has no org and the flag is off", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    prismaMock.team.findUnique.mockResolvedValue(
      createMockTeam({ id: 3, isOrganization: false, parent: null }) as never
    );

    const response = await callHandler({ ...signupBody, token: "invite-token" });

    expect(response.status).toBe(201);
    expect(lastUpsertedOrganizationId()).toBe(defaultOrgId);
    expect(createOrUpdateMemberships).toHaveBeenCalled();
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: defaultOrgId, userId: 42, role: "MEMBER" });
  });

  it("keeps a team invite outside any org when the flag is off and no default org exists yet", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockFindDefaultOrganizationId.mockResolvedValue(null);
    prismaMock.team.findUnique.mockResolvedValue(
      createMockTeam({ id: 3, isOrganization: false, parent: null }) as never
    );

    const response = await callHandler({ ...signupBody, token: "invite-token" });

    expect(response.status).toBe(201);
    expect(lastUpsertedOrganizationId()).toBeNull();
    expect(createOrUpdateMemberships).toHaveBeenCalled();
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("treats a sub-team invite as a top-level team invite with the flag off", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    prismaMock.team.findUnique.mockResolvedValue({
      ...createMockTeam({ id: 3, isOrganization: false, parent: { id: 11 } as never }),
      parentId: 11,
    } as never);

    const response = await callHandler({ ...signupBody, token: "invite-token" });

    expect(response.status).toBe(201);
    expect(lastUpsertedOrganizationId()).toBe(defaultOrgId);
    expect(isUsernameReservedDueToMigration).toHaveBeenCalled();
    expect(createOrUpdateMemberships).toHaveBeenCalledWith({
      user: { id: 42 },
      team: expect.objectContaining({ id: 3, parentId: null, parent: null }),
    });
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: defaultOrgId, userId: 42, role: "MEMBER" });
    expect(joinAnyChildTeamOnOrgInvite).not.toHaveBeenCalled();
  });

  it("joins the host org as MEMBER without a token", async () => {
    const response = await callHandler(signupBody);

    expect(response.status).toBe(201);
    expect(lastCreatedOrganizationId()).toBe(hostOrg.id);
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: hostOrg.id, userId: 42, role: "MEMBER" });
    expect(validateAndGetCorrectedUsernameAndEmail).toHaveBeenCalledWith(
      expect.objectContaining({ usernameOrganizationId: hostOrg.id })
    );
    expect(isUsernameReservedDueToMigration).not.toHaveBeenCalled();
    expect(mockFindDefaultOrganizationId).not.toHaveBeenCalled();
    expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
      userId: 42,
      email: "new@example.com",
      organizationId: hostOrg.id,
    });
    expect(prismaMock.user.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the request has no organization", async () => {
    mockGetOrgFromRequest.mockResolvedValue(null);

    const response = await callHandler(signupBody);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Organization not found" });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the org membership conflicts", async () => {
    mockAddMember.mockRejectedValue(
      ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
    );

    const response = await callHandler(signupBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS });
    expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [42] } } });
    expect(mockAcceptPendingInvitesOnSignup).not.toHaveBeenCalled();
  });

  it("still returns 409 and logs when removing the user after a membership conflict fails", async () => {
    mockAddMember.mockRejectedValue(
      ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
    );
    prismaMock.user.deleteMany.mockRejectedValue(new Error("db down"));

    const response = await callHandler(signupBody);

    expect(response.status).toBe(409);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to remove a user whose organization membership could not be created",
      { userId: 42, organizationId: hostOrg.id }
    );
  });

  it("rethrows membership errors other than conflicts", async () => {
    mockAddMember.mockRejectedValue(ErrorWithCode.Factory.NotFound("Organization not found"));

    await expect(callHandler(signupBody)).rejects.toThrow("Organization not found");
    expect(prismaMock.user.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [42] } } });
  });

  it("rethrows the original membership error when removing the user also fails", async () => {
    mockAddMember.mockRejectedValue(ErrorWithCode.Factory.NotFound("Organization not found"));
    prismaMock.user.deleteMany.mockRejectedValue(new Error("db down"));

    await expect(callHandler(signupBody)).rejects.toThrow("Organization not found");
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to remove a user whose organization membership could not be created",
      { userId: 42, organizationId: hostOrg.id }
    );
  });

  it("joins the parent org of an invited sub-team", async () => {
    prismaMock.team.findUnique.mockResolvedValue({
      ...createMockTeam({ id: 3, isOrganization: false, parent: { id: 11 } as never }),
      parentId: 11,
    } as never);

    const response = await callHandler({ ...signupBody, token: "invite-token" });

    expect(response.status).toBe(201);
    expect(lastUpsertedOrganizationId()).toBe(11);
    expect(createOrUpdateMemberships).toHaveBeenCalledWith({
      user: { id: 42 },
      team: expect.objectContaining({ id: 3, parentId: 11, parent: { id: 11 } }),
    });
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    expect(mockFindDefaultOrganizationId).not.toHaveBeenCalled();
    expect(mockAddMember).not.toHaveBeenCalled();
    expect(joinAnyChildTeamOnOrgInvite).toHaveBeenCalledWith({ userId: 42, org: { id: 11 } });
  });

  it("joins the inviting org itself", async () => {
    prismaMock.team.findUnique.mockResolvedValue(createMockTeam({ id: 5, isOrganization: true }) as never);

    const response = await callHandler({ ...signupBody, token: "invite-token" });

    expect(response.status).toBe(201);
    expect(lastUpsertedOrganizationId()).toBe(5);
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("joins the host org when the inviting team has no org", async () => {
    prismaMock.team.findUnique.mockResolvedValue(
      createMockTeam({ id: 3, isOrganization: false, parent: null }) as never
    );

    const response = await callHandler({ ...signupBody, token: "invite-token" });

    expect(response.status).toBe(201);
    expect(lastUpsertedOrganizationId()).toBe(hostOrg.id);
    expect(createOrUpdateMemberships).toHaveBeenCalled();
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: hostOrg.id, userId: 42, role: "MEMBER" });
    expect(isUsernameReservedDueToMigration).not.toHaveBeenCalled();
  });
});
