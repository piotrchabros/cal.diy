import { beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

const { mockGetServerSession, mockCurrent, mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockCurrent: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: mockGetServerSession,
}));

vi.mock("app/_trpc/context", () => ({
  createRouterCaller: vi.fn(async () => ({ current: mockCurrent })),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ getAll: () => [] })),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));

vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: vi.fn(() => true),
}));

describe("organization settings index page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: 7 } });
    mockCurrent.mockResolvedValue({ id: 3 });
  });

  it("redirects accepted members to the general tab", async () => {
    await expect(Page()).rejects.toThrow("REDIRECT:/settings/organization/general");
    expect(mockRedirect).toHaveBeenCalledWith("/settings/organization/general");
  });

  it("redirects signed-out visitors to login", async () => {
    mockGetServerSession.mockResolvedValue(null);

    await expect(Page()).rejects.toThrow("REDIRECT:/auth/login");
  });

  it("404s when the viewer has no accepted org membership", async () => {
    mockCurrent.mockRejectedValue(new Error("NOT_FOUND"));

    await expect(Page()).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});
