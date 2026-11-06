import type { GetServerSidePropsContext } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetServerSession, mockGetSafeRedirectUrlForOrganizations, mockFindFirst } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGetSafeRedirectUrlForOrganizations: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: mockGetServerSession,
}));

vi.mock("@calcom/features/organizations/lib/getOrganizationOrigin", () => ({
  getSafeRedirectUrlForOrganizations: mockGetSafeRedirectUrlForOrganizations,
}));

vi.mock("@calcom/prisma", () => ({
  default: { user: { findFirst: mockFindFirst } },
}));

vi.mock("next-auth/react", () => ({
  getCsrfToken: vi.fn().mockResolvedValue("csrf"),
}));

vi.mock("@server/lib/constants", () => ({
  IS_GOOGLE_LOGIN_ENABLED: false,
}));

import { getServerSideProps } from "./getServerSideProps";

function buildContext(query: Record<string, string> = {}): GetServerSidePropsContext {
  return { req: {}, res: {}, query, resolvedUrl: "/auth/login" } as unknown as GetServerSidePropsContext;
}

describe("login getServerSideProps", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue({ user: { id: 1 } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects a signed-in user to the safe callback URL", async () => {
    mockGetSafeRedirectUrlForOrganizations.mockResolvedValue("https://cal.acme.com/team/x");

    const result = await getServerSideProps(buildContext({ callbackUrl: "https://cal.acme.com/team/x" }));

    expect(mockGetSafeRedirectUrlForOrganizations).toHaveBeenCalledWith("https://cal.acme.com/team/x");
    expect(result).toEqual({ redirect: { destination: "https://cal.acme.com/team/x", permanent: false } });
  });

  it("redirects to / when the callback URL is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetSafeRedirectUrlForOrganizations.mockRejectedValue(new Error("Pass an absolute URL"));

    const result = await getServerSideProps(buildContext({ callbackUrl: "/relative" }));

    expect(result).toEqual({ redirect: { destination: "/", permanent: false } });
  });

  it("redirects to / when there is no callback URL", async () => {
    const result = await getServerSideProps(buildContext());

    expect(mockGetSafeRedirectUrlForOrganizations).not.toHaveBeenCalled();
    expect(result).toEqual({ redirect: { destination: "/", permanent: false } });
  });

  it("does not resolve the callback URL for a signed-out user", async () => {
    mockGetServerSession.mockResolvedValue(null);
    mockFindFirst.mockResolvedValue({ id: 1 });

    const result = await getServerSideProps(buildContext({ callbackUrl: "https://cal.acme.com/x" }));

    expect(mockGetSafeRedirectUrlForOrganizations).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ props: expect.objectContaining({ csrfToken: "csrf" }) })
    );
  });
});
