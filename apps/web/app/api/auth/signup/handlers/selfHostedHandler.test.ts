import type { Mock } from "vitest";
import { vi } from "vitest";

import {
  prismaMock,
  resetPrismaMock,
} from "@calcom/features/auth/signup/handlers/__tests__/mocks/prisma.mocks";
import {
  createMockTeam,
  createMockFoundToken,
} from "@calcom/features/auth/signup/handlers/__tests__/mocks/signup.factories";
import type { SignupBody } from "@calcom/features/auth/signup/handlers/__tests__/mocks/signup.factories";

const mockFindTokenByToken: Mock = vi.fn();
const mockValidateAndGetCorrectedUsernameForTeam: Mock = vi.fn();
const mockAcceptPendingInvitesOnSignup: Mock = vi.fn();

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

// Import after mocks
import { describe, expect, it } from "vitest";

import handler from "./selfHostedHandler";
import { runP2002TestSuite } from "@calcom/features/auth/signup/handlers/__tests__/p2002.test-suite";

function callHandler(body: SignupBody): ReturnType<typeof handler> {
  return handler(body as unknown as Record<string, string>);
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
