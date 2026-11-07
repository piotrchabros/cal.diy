import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUserCount, mockUserCreate, mockEnsureDefault, mockAddMember } = vi.hoisted(() => ({
  mockUserCount: vi.fn(),
  mockUserCreate: vi.fn(),
  mockEnsureDefault: vi.fn(),
  mockAddMember: vi.fn(),
}));

vi.mock("app/api/defaultResponderForAppDir", () => ({
  defaultResponderForAppDir:
    (handler: (req: NextRequest) => Promise<Response>) =>
    (req: NextRequest, _context: { params: Promise<Record<string, string>> }) =>
      handler(req),
}));

vi.mock("@calcom/prisma", () => ({
  default: { user: { count: mockUserCount, create: mockUserCreate } },
}));

vi.mock("@calcom/lib/auth/hashPassword", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));

vi.mock("@calcom/features/organizations/di/OrganizationService.container", () => ({
  getOrganizationService: () => ({ ensureDefault: mockEnsureDefault }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember: mockAddMember }),
}));

import { POST } from "./route";

const validBody = {
  username: "admin",
  full_name: "Instance Admin",
  email_address: "Admin@Example.com",
  password: "ValidPassword1234567",
};

function buildRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function callPost(body: unknown) {
  return POST(buildRequest(body), { params: Promise.resolve({}) });
}

describe("POST /api/auth/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserCount.mockResolvedValue(0);
    mockUserCreate.mockResolvedValue({ id: 7 });
    mockEnsureDefault.mockResolvedValue({ id: 1, slug: "default", isDefault: true });
    mockAddMember.mockResolvedValue({ userId: 7, organizationId: 1, role: "OWNER" });
  });

  it("creates the first admin in the default organization", async () => {
    const res = await callPost(validBody);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "First admin user created successfully." });
    expect(mockEnsureDefault).toHaveBeenCalledTimes(1);
    expect(mockUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: "admin",
          email: "admin@example.com",
          role: "ADMIN",
          organizationId: 1,
          password: { create: { hash: "hashed-password" } },
        }),
      })
    );
  });

  it("makes the first admin the owner of the default organization", async () => {
    await callPost(validBody);

    expect(mockAddMember).toHaveBeenCalledWith({ organizationId: 1, userId: 7, role: "OWNER" });
  });

  it("rejects setup when users already exist", async () => {
    mockUserCount.mockResolvedValue(3);

    await expect(callPost(validBody)).rejects.toMatchObject({
      statusCode: 400,
      message: "No setup needed.",
    });
    expect(mockEnsureDefault).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("does not touch the organization when the input is invalid", async () => {
    await expect(callPost({ ...validBody, password: "short" })).rejects.toMatchObject({ statusCode: 422 });
    expect(mockEnsureDefault).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });
});
