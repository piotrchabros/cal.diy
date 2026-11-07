import type { PrismaClient } from "@calcom/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAcceptPendingInvitesOnSignup = vi.fn();
const mockLoggerError = vi.fn();
const mockFindNewUserOrganizationId = vi.fn();
const mockAddMember = vi.fn();

vi.mock("./findNewUserOrganizationId", () => ({
  findNewUserOrganizationId: (...args: unknown[]) => mockFindNewUserOrganizationId(...args),
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember: mockAddMember }),
}));

vi.mock("@calcom/lib/random", () => ({
  randomString: () => "AbC123",
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
    user: {
      create: vi.fn().mockResolvedValue(createdUser),
      delete: vi.fn().mockResolvedValue({ id: 42 }),
    },
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
  vi.clearAllMocks();
  mockFindNewUserOrganizationId.mockResolvedValue(null);
  mockAddMember.mockResolvedValue({ userId: 42, organizationId: 1, role: "MEMBER" });
  mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "accepted", teamIds: [] });
});

describe("CalComAdapter.createUser – organization", () => {
  const signUp = { name: "New User", email: "new@example.com", emailVerified: null, image: null };

  it("passes the request headers getter to the organization lookup", async () => {
    const getRequestHeaders = () => new Headers();

    await CalComAdapter(createPrismaStub(createdUser), { getRequestHeaders }).createUser?.(signUp);

    expect(mockFindNewUserOrganizationId).toHaveBeenCalledWith(getRequestHeaders);
  });

  it("passes undefined to the organization lookup without deps", async () => {
    await CalComAdapter(createPrismaStub(createdUser)).createUser?.(signUp);

    expect(mockFindNewUserOrganizationId).toHaveBeenCalledWith(undefined);
  });

  it("connects the organization and adds the user as a member", async () => {
    mockFindNewUserOrganizationId.mockResolvedValue(1);
    const prismaStub = createPrismaStub(createdUser);

    await CalComAdapter(prismaStub).createUser?.(signUp);

    expect(prismaStub.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organization: { connect: { id: 1 } } }),
    });
    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: 1, userId: 42, role: "MEMBER" });
  });

  it("sets no organization and adds no membership while no organization is found", async () => {
    const prismaStub = createPrismaStub(createdUser);

    await CalComAdapter(prismaStub).createUser?.(signUp);

    expect(prismaStub.user.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ organization: expect.anything() }),
    });
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("deletes the user and rejects when adding the membership fails", async () => {
    mockFindNewUserOrganizationId.mockResolvedValue(1);
    mockAddMember.mockRejectedValue(new Error("no profile"));
    const prismaStub = createPrismaStub(createdUser);

    await expect(CalComAdapter(prismaStub).createUser?.(signUp)).rejects.toThrow(
      "Unable to add magic-link sign-up 42 to organization 1"
    );

    expect(prismaStub.user.delete).toHaveBeenCalledWith({ where: { id: 42 }, select: { id: true } });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: 42, organizationId: 1, error: expect.stringContaining("no profile") })
    );
    expect(mockAcceptPendingInvitesOnSignup).not.toHaveBeenCalled();
  });
});

describe("CalComAdapter.createUser – username", () => {
  it("derives the username from the email local part when no name is given", async () => {
    const prismaStub = createPrismaStub(createdUser);

    await CalComAdapter(prismaStub).createUser?.({
      name: null,
      email: "jdoe@example.com",
      emailVerified: null,
      image: null,
    });

    expect(prismaStub.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ username: "jdoe-abc123" }),
    });
  });

  it("derives the username from the name when present", async () => {
    const prismaStub = createPrismaStub(createdUser);

    await CalComAdapter(prismaStub).createUser?.({
      name: "Jane Doe",
      email: "someone@example.com",
      emailVerified: null,
      image: null,
    });

    expect(prismaStub.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ username: "jane-doe-abc123" }),
    });
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
      organizationId: null,
    });
    expect(result).toMatchObject({ id: "42", email: "invited@example.com" });
  });

  it("scopes pending invites to the sign-up's organization", async () => {
    mockFindNewUserOrganizationId.mockResolvedValue(7);
    mockAcceptPendingInvitesOnSignup.mockResolvedValue({ status: "accepted", teamIds: [1] });
    const adapter = CalComAdapter(createPrismaStub(createdUser));

    await adapter.createUser?.({
      name: "Invited User",
      email: "invited@example.com",
      emailVerified: null,
      image: null,
    });

    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: 7, userId: 42, role: "MEMBER" });
    expect(mockAcceptPendingInvitesOnSignup).toHaveBeenCalledWith({
      userId: 42,
      email: "invited@example.com",
      organizationId: 7,
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
