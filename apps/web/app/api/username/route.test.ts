import { getOrgFromRequest } from "@calcom/features/organizations/lib/getOrgFromRequest";
import { checkUsername } from "@calcom/features/profile/lib/checkUsername";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("app/api/defaultResponderForAppDir", () => ({
  defaultResponderForAppDir:
    (handler: (req: NextRequest) => Promise<Response>) =>
    (req: NextRequest, _context: { params: Promise<Record<string, string>> }) =>
      handler(req),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ host: "acme.cal.diy" })),
}));

vi.mock("@calcom/features/profile/lib/checkUsername", () => ({
  checkUsername: vi.fn(),
}));

vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: vi.fn(),
}));

const mockCheckUsername = vi.mocked(checkUsername);
const mockGetOrgFromRequest = vi.mocked(getOrgFromRequest);

const availableResult = { available: true, premium: false, suggestedUsername: "" };
const acmeOrg = { id: 42, slug: "acme", domain: "acme.cal.diy", isDefault: false };

function buildRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/username", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function callPost(body: unknown) {
  return POST(buildRequest(body), { params: Promise.resolve({}) });
}

describe("POST /api/username", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckUsername.mockResolvedValue(availableResult);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
    });

    it("checks the username in the namespace of the orgSlug from the body", async () => {
      const res = await callPost({ username: "alice", orgSlug: "acme" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(availableResult);
      expect(mockCheckUsername).toHaveBeenCalledWith("alice", { orgSlug: "acme" });
      expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    });

    it("checks the username globally when no orgSlug is sent", async () => {
      const res = await callPost({ username: "alice" });

      expect(res.status).toBe(200);
      expect(mockCheckUsername).toHaveBeenCalledWith("alice", null);
      expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
    });
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("checks the username in the request organization and ignores the body orgSlug", async () => {
      mockGetOrgFromRequest.mockResolvedValue(acmeOrg);

      const res = await callPost({ username: "alice", orgSlug: "other-org" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(availableResult);
      expect(mockGetOrgFromRequest).toHaveBeenCalledTimes(1);
      expect(mockCheckUsername).toHaveBeenCalledWith("alice", { organizationId: 42 });
    });

    it("returns 404 when the request host does not resolve to an organization", async () => {
      mockGetOrgFromRequest.mockResolvedValue(null);

      const res = await callPost({ username: "alice" });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Organization not found" });
      expect(mockCheckUsername).not.toHaveBeenCalled();
    });
  });

  it("returns 400 for an invalid body", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");

    const res = await callPost({ orgSlug: "acme" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Failed to check username availability" });
    expect(mockCheckUsername).not.toHaveBeenCalled();
  });
});
