import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamEventGroup, createUserEventGroup } from "./transformUtils";

const { mockGetBaseUrl } = vi.hoisted(() => ({
  mockGetBaseUrl: vi.fn(),
}));

vi.mock("@calcom/features/organizations/di/OrganizationUrlService.container", () => ({
  getOrganizationUrlService: () => ({ getBaseUrl: mockGetBaseUrl }),
}));

vi.mock("@calcom/lib/getAvatarUrl", () => ({
  getUserAvatarUrl: vi.fn().mockReturnValue("https://avatar.com/user.jpg"),
}));

vi.mock("@calcom/lib/defaultAvatarImage", () => ({
  getPlaceholderAvatar: vi.fn().mockReturnValue("https://avatar.com/placeholder.jpg"),
}));

const permissions = { canCreate: true, canEdit: true, canDelete: true, canRead: true };

describe("transformUtils booker URLs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBaseUrl.mockImplementation(async ({ organizationId }: { organizationId: number | null }) =>
      organizationId === null ? "https://app.example.com" : `https://org-${organizationId}.example.com`
    );
  });

  it("resolves the user group URL from the profile's organizationId", async () => {
    const group = await createUserEventGroup(
      { username: "alice", name: "Alice", avatarUrl: null, organizationId: 42 },
      false
    );

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 42 });
    expect(group.bookerUrl).toBe("https://org-42.example.com");
  });

  it("falls back to the default domain for a user outside an organization", async () => {
    const group = await createUserEventGroup(
      { username: "bob", name: "Bob", avatarUrl: null, organizationId: null },
      false
    );

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: null });
    expect(group.bookerUrl).toBe("https://app.example.com");
  });

  it("resolves the team group URL from the team's parentId, not the parent slug", async () => {
    const group = await createTeamEventGroup(
      {
        team: {
          id: 7,
          name: "Sales",
          slug: "sales",
          logoUrl: null,
          parentId: 99,
          isOrganization: false,
          parent: { name: "Acme", slug: "acme", logoUrl: null, metadata: {} },
          metadata: {},
        },
        role: MembershipRole.MEMBER,
      },
      MembershipRole.MEMBER,
      "sales",
      permissions
    );

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 99 });
    expect(group.bookerUrl).toBe("https://org-99.example.com");
    expect(group.parentId).toBe(99);
  });

  it("uses the default domain for a team without a parent organization", async () => {
    const group = await createTeamEventGroup(
      {
        team: {
          id: 8,
          name: "Solo",
          slug: "solo",
          logoUrl: null,
          parentId: null,
          isOrganization: false,
          parent: null,
          metadata: {},
        },
        role: MembershipRole.ADMIN,
      },
      MembershipRole.ADMIN,
      "team/solo",
      permissions
    );

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: null });
    expect(group.bookerUrl).toBe("https://app.example.com");
  });

  it("resolves the organization's own URL for a team that is the organization", async () => {
    const group = await createTeamEventGroup(
      {
        team: {
          id: 99,
          name: "Acme",
          slug: "acme",
          logoUrl: null,
          parentId: null,
          isOrganization: true,
          parent: null,
          metadata: {},
        },
        role: MembershipRole.OWNER,
      },
      MembershipRole.OWNER,
      "team/acme",
      permissions
    );

    expect(mockGetBaseUrl).toHaveBeenCalledWith({ organizationId: 99 });
    expect(group.bookerUrl).toBe("https://org-99.example.com");
  });
});
