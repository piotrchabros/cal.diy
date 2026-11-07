import type { PrismaClient } from "@calcom/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAcceptPendingInvitesOnSignup = vi.fn();
const mockLoggerError = vi.fn();
const mockFindDefaultOrganizationId = vi.fn();

vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  findDefaultOrganizationId: () => mockFindDefaultOrganizationId(),
}));

vi.mock("@calcom/features/membership/services/TeamMembersService", () => ({
  TeamMembersService: class {
    acceptPendingInvitesOnSignup(...args: unknown[]) {
      return mockAcceptPendingInvitesOnSignup(...args);
    }
  },
}));

vi.mock("@calcom/lib/logger", () => ({
  default: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

import CalComAdapter from "./next-auth-custom-adapter";

const createPrismaStub = (createdUser: unknown) =>
  ({
    user: { create: vi.fn().mockResolvedValue(createdUser) },
  }) as unknown as PrismaClient;

const createdUser = {
  id: 42,
  uuid: "uuid-42",
  name: "Invited User",
  email: "invited@example.com",
  emailVerified: new Date("2026-01-01T00:00:00Z"),
  avatarUrl: null,
};

beforeEach(() => {
  mockFindDefaultOrganizationId.mockResolvedValue(1);
});

describe("CalComAdapter.createUser – default organization", () => {
  const signUp = { name: "New User", email: "new@example.com", emailVerified: null, image: null };

  it("connects the default organization", async () => {
    const prismaStub = createPrismaStub(createdUser);

    await CalComAdapter(prismaStub).createUser?.(signUp);

    expect(prismaStub.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organization: { connect: { id: 1 } } }),
    });
  });

  it("creates no user when no default organization exists", async () => {
    mockFindDefaultOrganizationId.mockRejectedValue(new Error("No default organization"));
    const prismaStub = createPrismaStub(createdUser);

    await expect(CalComAdapter(prismaStub).createUser?.(signUp)).rejects.toThrow("No default organization");

    expect(prismaStub.user.create).not.toHaveBeenCalled();
  });
});

describe("CalComAdapter.createUser – team invite materialization", () => {
  it("accepts pending team invites after an OAuth signup", async () => {
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "accepted", teamIds: [1] });
    const adapter = CalComAdapter(createPrismaStub(createdUser));

    const result = await adapter.createUser?.({
      name: "Invited User",
      email: "invited@example.com",
      emailVerified: new Date("2026-01-01T00:00:00Z"),
      image: null,
    });

    expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
      userId: 42,
      email: "invited@example.com",
      organizationId: 1,
    });
    expect(result).toMatchObject({ id: "42", email: "invited@example.com" });
  });

  it("scopes pending invites to the default organization", async () => {
    mockFindDefaultOrganizationId.mockResolvedValue(1);
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "accepted", teamIds: [1] });
    const adapter = CalComAdapter(createPrismaStub(createdUser));

    await adapter.createUser?.({
      name: "Invited User",
      email: "invited@example.com",
      emailVerified: null,
      image: null,
    });

    expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
      userId: 42,
      email: "invited@example.com",
      organizationId: 1,
    });
  });

  it("still creates the user when invite materialization fails", async () => {
    mockAcceptPendingInvitesOnSignup.mockRejectedValue(new Error("db down"));
    const adapter = CalComAdapter(createPrismaStub(createdUser));

    const result = await adapter.createUser?.({
      name: "Invited User",
      email: "invited@example.com",
      emailVerified: null,
      image: null,
    });

    expect(result).toMatchObject({ id: "42" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to materialize pending team invites on OAuth signup",
      { userId: 42 }
    );
  });

  it("skips invite materialization when the created user has no email", async () => {
    mockAcceptPendingInvitesOnSignup.mockClear();
    const adapter = CalComAdapter(createPrismaStub({ ...createdUser, email: "" }));

    await adapter.createUser?.({
      name: "Invited User",
      email: "",
      emailVerified: null,
      image: null,
    });

    expect(mockAcceptPendingInvitesOnSignup).not.toHaveBeenCalled();
  });
});
