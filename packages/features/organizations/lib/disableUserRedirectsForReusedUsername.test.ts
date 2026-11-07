import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disableByFrom: vi.fn(),
  isOrganizationsEnabled: vi.fn(),
}));

vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: mocks.isOrganizationsEnabled,
}));

vi.mock("../di/TempOrgRedirectRepository.container", () => ({
  getTempOrgRedirectRepository: () => ({ disableByFrom: mocks.disableByFrom }),
}));

import { disableUserRedirectsForReusedUsername } from "./disableUserRedirectsForReusedUsername";

describe("disableUserRedirectsForReusedUsername", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disableByFrom.mockResolvedValue(1);
  });

  it("does nothing when organizations are disabled", async () => {
    mocks.isOrganizationsEnabled.mockReturnValue(false);

    await disableUserRedirectsForReusedUsername({ organizationId: 5, username: "alice" });

    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });

  it.each([null, undefined])("does nothing when organizationId is %j", async (organizationId) => {
    mocks.isOrganizationsEnabled.mockReturnValue(true);

    await disableUserRedirectsForReusedUsername({ organizationId, username: "alice" });

    expect(mocks.disableByFrom).not.toHaveBeenCalled();
  });

  it("disables User redirects from the username in the organization", async () => {
    mocks.isOrganizationsEnabled.mockReturnValue(true);

    await disableUserRedirectsForReusedUsername({ organizationId: 5, username: "alice" });

    expect(mocks.disableByFrom).toHaveBeenCalledWith({ fromOrgId: 5, from: "alice", types: ["User"] });
  });
});
