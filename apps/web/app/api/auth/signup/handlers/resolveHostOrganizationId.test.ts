import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetOrgFromRequest: Mock = vi.fn();
const mockRequireDefaultOrganizationId: Mock = vi.fn();

vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: (...args: unknown[]) => mockGetOrgFromRequest(...args),
}));
vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  requireDefaultOrganizationId: () => mockRequireDefaultOrganizationId(),
}));

import { resolveHostOrganizationId } from "./resolveHostOrganizationId";

const DEFAULT_ORG_ID = 99;
const requestHeaders = new Headers({ host: "acme.cal.diy" });

describe("resolveHostOrganizationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
  });

  it("returns the default organization with the flag off without looking at the request", async () => {
    expect(await resolveHostOrganizationId(false, requestHeaders)).toBe(DEFAULT_ORG_ID);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
  });

  it("returns the host organization with the flag on", async () => {
    mockGetOrgFromRequest.mockResolvedValue({ id: 7 });

    expect(await resolveHostOrganizationId(true, requestHeaders)).toBe(7);
    expect(mockGetOrgFromRequest).toHaveBeenCalledWith(requestHeaders);
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
  });

  it("returns null with the flag on when the host has no organization", async () => {
    mockGetOrgFromRequest.mockResolvedValue(null);

    expect(await resolveHostOrganizationId(true, requestHeaders)).toBeNull();
  });
});
