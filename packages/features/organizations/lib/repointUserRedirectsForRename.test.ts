import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateToUrl: vi.fn(),
  getBaseUrl: vi.fn(),
  isOrganizationsEnabled: vi.fn(),
}));

vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: mocks.isOrganizationsEnabled,
}));

vi.mock("../di/TempOrgRedirectRepository.container", () => ({
  getTempOrgRedirectRepository: () => ({ updateToUrl: mocks.updateToUrl }),
}));

vi.mock("../di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: mocks.getBaseUrl }),
}));

import { repointUserRedirectsForRename } from "./repointUserRedirectsForRename";

describe("repointUserRedirectsForRename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isOrganizationsEnabled.mockReturnValue(true);
    mocks.getBaseUrl.mockResolvedValue("https://acme.example.com");
    mocks.updateToUrl.mockResolvedValue(1);
  });

  it("does nothing when organizations are disabled", async () => {
    mocks.isOrganizationsEnabled.mockReturnValue(false);

    await repointUserRedirectsForRename({ organizationId: 5, oldUsername: "alice", newUsername: "alicia" });

    expect(mocks.getBaseUrl).not.toHaveBeenCalled();
    expect(mocks.updateToUrl).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no organization", input: { organizationId: null, oldUsername: "alice", newUsername: "alicia" } },
    { name: "no old username", input: { organizationId: 5, oldUsername: null, newUsername: "alicia" } },
    {
      name: "an unchanged username",
      input: { organizationId: 5, oldUsername: "alice", newUsername: "alice" },
    },
  ])("does nothing with $name", async ({ input }) => {
    await repointUserRedirectsForRename(input);

    expect(mocks.updateToUrl).not.toHaveBeenCalled();
  });

  it("repoints User redirects aimed at the old URL in the user's organization to the new URL", async () => {
    await repointUserRedirectsForRename({ organizationId: 5, oldUsername: "alice", newUsername: "alicia" });

    expect(mocks.getBaseUrl).toHaveBeenCalledWith({ organizationId: 5 });
    expect(mocks.updateToUrl).toHaveBeenCalledWith({
      types: ["User"],
      toUrl: "https://acme.example.com/alice",
      newToUrl: "https://acme.example.com/alicia",
    });
  });
});
