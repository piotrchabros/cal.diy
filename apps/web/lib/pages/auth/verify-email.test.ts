import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, getBaseUrlForUser, getGettingStartedPath } = vi.hoisted(() => ({
  prismaMock: {
    verificationToken: { findFirst: vi.fn(), delete: vi.fn() },
    secondaryEmail: { update: vi.fn(), findUnique: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  getBaseUrlForUser: vi.fn(),
  getGettingStartedPath: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ prisma: prismaMock, default: prismaMock }));

vi.mock("@calcom/features/onboarding/lib/onboarding-path.service", () => ({
  OnboardingPathService: { getGettingStartedPath },
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrlForUser }),
}));

vi.mock("@calcom/lib/constants", () => ({
  IS_STRIPE_ENABLED: false,
  WEBAPP_URL: "https://app.example.com",
}));

import { handler } from "./verify-email";

const WEBAPP_URL = "https://app.example.com";
const ORG_URL = "https://acme.example.com";

function buildRes() {
  const res = {
    redirect: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function buildReq() {
  return { query: { token: "token-123" } } as unknown as NextApiRequest;
}

const validToken = {
  id: 7,
  identifier: "user@example.com",
  token: "token-123",
  expires: new Date(Date.now() + 60 * 60 * 1000),
  secondaryEmailId: null as number | null,
};

describe("verify-email handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGettingStartedPath.mockResolvedValue("/getting-started");
    getBaseUrlForUser.mockResolvedValue(ORG_URL);
  });

  it("redirects a verified secondary email to the profile settings on the owner's organization URL", async () => {
    prismaMock.verificationToken.findFirst.mockResolvedValue({ ...validToken, secondaryEmailId: 3 });
    prismaMock.secondaryEmail.update.mockResolvedValue({ userId: 42 });
    const res = buildRes();

    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(prismaMock.secondaryEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({ select: { userId: true } })
    );
    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 42 });
    expect(prismaMock.verificationToken.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(res.redirect).toHaveBeenCalledWith(`${ORG_URL}/settings/my-account/profile`);
  });

  it("redirects a user who completed onboarding to event types on their organization URL", async () => {
    prismaMock.verificationToken.findFirst.mockResolvedValue(validToken);
    prismaMock.user.findFirst.mockResolvedValue({
      id: 42,
      email: "user@example.com",
      metadata: null,
      completedOnboarding: true,
    });
    const res = buildRes();

    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(getBaseUrlForUser).toHaveBeenCalledWith({ userId: 42 });
    expect(res.redirect).toHaveBeenCalledWith(`${ORG_URL}/event-types`);
  });

  it("uses WEBAPP_URL when the service resolves to it", async () => {
    getBaseUrlForUser.mockResolvedValue(WEBAPP_URL);
    prismaMock.verificationToken.findFirst.mockResolvedValue(validToken);
    prismaMock.user.findFirst.mockResolvedValue({
      id: 42,
      email: "user@example.com",
      metadata: null,
      completedOnboarding: false,
    });
    const res = buildRes();

    await handler(buildReq(), res as unknown as NextApiResponse);

    expect(res.redirect).toHaveBeenCalledWith(`${WEBAPP_URL}/getting-started`);
  });
});
