import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findNewUserOrganizationId } from "./findNewUserOrganizationId";

const { mockGetOrgFromRequest, mockRequireDefaultOrganizationId, mockIsOrganizationsEnabled } = vi.hoisted(
  () => ({
    mockGetOrgFromRequest: vi.fn(),
    mockRequireDefaultOrganizationId: vi.fn(),
    mockIsOrganizationsEnabled: vi.fn(),
  })
);

vi.mock("@calcom/features/organizations/lib/getOrgFromRequest", () => ({
  getOrgFromRequest: mockGetOrgFromRequest,
}));

vi.mock("@calcom/features/organizations/lib/defaultOrganization", () => ({
  requireDefaultOrganizationId: mockRequireDefaultOrganizationId,
}));

vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: mockIsOrganizationsEnabled,
}));

const DEFAULT_ORG_ID = 1;
const ORG = { id: 7, slug: "bespokesoft", domain: "cal.bespokesoft.pl", isDefault: false };
const getRequestHeaders = (): Headers => new Headers({ host: "cal.bespokesoft.pl" });

describe("findNewUserOrganizationId", () => {
  beforeEach(() => {
    mockIsOrganizationsEnabled.mockReturnValue(true);
    mockGetOrgFromRequest.mockResolvedValue(ORG);
    mockRequireDefaultOrganizationId.mockResolvedValue(DEFAULT_ORG_ID);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the default organization without resolving the request when organizations are disabled", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);

    await expect(findNewUserOrganizationId(getRequestHeaders)).resolves.toBe(DEFAULT_ORG_ID);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
  });

  it("returns the organization resolved from the request headers", async () => {
    await expect(findNewUserOrganizationId(getRequestHeaders)).resolves.toBe(ORG.id);
    expect(mockGetOrgFromRequest).toHaveBeenCalledWith(expect.any(Headers));
    expect(mockRequireDefaultOrganizationId).not.toHaveBeenCalled();
  });

  it("falls back to the default organization when the request matches no organization", async () => {
    mockGetOrgFromRequest.mockResolvedValue(null);

    await expect(findNewUserOrganizationId(getRequestHeaders)).resolves.toBe(DEFAULT_ORG_ID);
  });

  it("falls back to the default organization without resolving the request when no headers are available", async () => {
    await expect(findNewUserOrganizationId()).resolves.toBe(DEFAULT_ORG_ID);
    expect(mockGetOrgFromRequest).not.toHaveBeenCalled();
  });

  it("rejects when no default organization exists", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    const error = ErrorWithCode.Factory.PreconditionFailed(
      "No default organization: no organization uses the domain of NEXT_PUBLIC_WEBAPP_URL"
    );
    mockRequireDefaultOrganizationId.mockRejectedValue(error);

    await expect(findNewUserOrganizationId()).rejects.toBe(error);
  });
});
