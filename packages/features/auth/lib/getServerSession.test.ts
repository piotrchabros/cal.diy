import type { NextApiRequest } from "next";
import type { RequestMethod } from "node-mocks-http";
import { createMocks } from "node-mocks-http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to import mocks before vi.mock hoisting
const {
  prismaMock,
  resetPrismaMock,
  createLoggerMock,
  createPrismaMock,
  createUserRepositoryMock,
  createAvatarUrlMock,
  createSafeStringifyMock,
  createGetTokenMock,
  createMockUser,
  createMockToken,
}: typeof import("../__mocks__/getServerSession.mocks") = await vi.hoisted(
  async () => await import("../__mocks__/getServerSession.mocks")
);

vi.mock("@calcom/lib/logger", createLoggerMock);
vi.mock("@calcom/prisma", createPrismaMock);
vi.mock("@calcom/features/users/repositories/UserRepository", createUserRepositoryMock);
vi.mock("@calcom/lib/getAvatarUrl", createAvatarUrlMock);
vi.mock("@calcom/lib/safeStringify", createSafeStringifyMock);
vi.mock("next-auth/jwt", createGetTokenMock);

const { isSessionInRequestOrganizationMock } = vi.hoisted(() => ({
  isSessionInRequestOrganizationMock: vi.fn(),
}));

vi.mock("./isSessionInRequestOrganization", () => ({
  isSessionInRequestOrganization: isSessionInRequestOrganizationMock,
}));

import { getToken } from "next-auth/jwt";
import { getServerSession } from "./getServerSession";

type MockNextApiRequest = ReturnType<typeof createMocks<NextApiRequest>>["req"];

function createMockRequest(method: RequestMethod = "GET"): MockNextApiRequest {
  const { req } = createMocks<NextApiRequest>({ method });
  return req;
}

function setupGetTokenMock(tokenData: object | null): void {
  vi.mocked(getToken).mockResolvedValue(tokenData as Record<string, unknown> | null);
}

describe("getServerSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPrismaMock();
    isSessionInRequestOrganizationMock.mockResolvedValue(true);
  });

  describe("Token Validation", () => {
    it.each([
      ["no token", null],
      ["no email", { sub: "5" }],
      ["no sub", { email: "user@example.com" }],
    ])("returns null when token is invalid: %s", async (_, token) => {
      setupGetTokenMock(token);

      const result = await getServerSession({ req: createMockRequest() });
      expect(result).toBeNull();
    });
  });

  describe("User ID Validation", () => {
    it.each(["", "invalid", "0", "-1"])("returns null when token.sub is invalid (%s)", async (sub) => {
      setupGetTokenMock(createMockToken({ sub }));

      const result = await getServerSession({ req: createMockRequest() });

      expect(result).toBeNull();
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("User Lookup", () => {
    it("looks up user by ID from token.sub", async () => {
      const mockUser = createMockUser({ id: 123 });
      setupGetTokenMock(createMockToken({ sub: "123" }));
      prismaMock.user.findUnique.mockResolvedValue(mockUser);

      await getServerSession({ req: createMockRequest() });

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: 123 },
      });
    });

    it("returns null when user not found in database", async () => {
      setupGetTokenMock(createMockToken({ sub: "999" }));
      prismaMock.user.findUnique.mockResolvedValue(null);

      const result = await getServerSession({ req: createMockRequest() });
      expect(result).toBeNull();
    });

    it("returns session with correct user data", async () => {
      const mockUser = createMockUser();
      setupGetTokenMock(createMockToken());
      prismaMock.user.findUnique.mockResolvedValue(mockUser);

      const result = await getServerSession({ req: createMockRequest() });

      expect(result).toMatchObject({
        user: {
          id: mockUser.id,
          email: mockUser.email,
        },
      });
    });
  });

  describe("User Resolution", () => {
    it("resolves user by token subject ID", async () => {
      const token = createMockToken({
        sub: "999",
        email: "user@example.com",
      });

      setupGetTokenMock(token);
      prismaMock.user.findUnique.mockResolvedValue(null);

      await getServerSession({ req: createMockRequest() });

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: 999 },
      });
    });

    it("returns user data from database lookup", async () => {
      const dbUser = createMockUser({ id: 999, email: "db-user@example.com" });
      const token = createMockToken({
        sub: "999",
        email: "token-email@example.com",
      });

      setupGetTokenMock(token);
      prismaMock.user.findUnique.mockResolvedValue(dbUser);

      const result = await getServerSession({ req: createMockRequest() });

      expect(result).toMatchObject({
        user: {
          id: 999,
          email: "db-user@example.com",
        },
      });
    });

    it("uses ID field for database queries", async () => {
      const mockUser = createMockUser();
      setupGetTokenMock(createMockToken());
      prismaMock.user.findUnique.mockResolvedValue(mockUser);

      await getServerSession({ req: createMockRequest() });

      const calls = prismaMock.user.findUnique.mock.calls;
      for (const call of calls) {
        const whereClause = call[0]?.where as Record<string, unknown>;
        expect(whereClause).toHaveProperty("id");
        expect(whereClause).not.toHaveProperty("email");
      }
    });
  });

  describe("Organization check", () => {
    it("returns null without querying the user when the session is outside the request organization", async () => {
      setupGetTokenMock(createMockToken({ sub: "321" }));
      isSessionInRequestOrganizationMock.mockResolvedValue(false);

      const result = await getServerSession({ req: createMockRequest() });

      expect(result).toBeNull();
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    });

    it("passes the user ID and request headers to the organization check", async () => {
      const req = createMockRequest();
      setupGetTokenMock(createMockToken({ sub: "322" }));
      prismaMock.user.findUnique.mockResolvedValue(createMockUser({ id: 322 }));

      await getServerSession({ req });

      expect(isSessionInRequestOrganizationMock).toHaveBeenCalledWith({ userId: 322, headers: req.headers });
    });

    it("does not serve a cached session when the token is reused outside the user's organization", async () => {
      const token = createMockToken({ sub: "323" });
      setupGetTokenMock(token);
      prismaMock.user.findUnique.mockResolvedValue(createMockUser({ id: 323 }));

      const first = await getServerSession({ req: createMockRequest() });
      expect(first).not.toBeNull();

      isSessionInRequestOrganizationMock.mockResolvedValue(false);
      const second = await getServerSession({ req: createMockRequest() });

      expect(second).toBeNull();
    });

    it("does not run the organization check for an invalid token subject", async () => {
      setupGetTokenMock(createMockToken({ sub: "invalid" }));

      const result = await getServerSession({ req: createMockRequest() });

      expect(result).toBeNull();
      expect(isSessionInRequestOrganizationMock).not.toHaveBeenCalled();
    });
  });
});
