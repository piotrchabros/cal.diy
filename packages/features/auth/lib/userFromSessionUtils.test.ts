import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnlockedUserForSession, mockEnrichUserWithTheProfile, mockIsOrganizationsEnabled } =
  vi.hoisted(() => ({
    mockFindUnlockedUserForSession: vi.fn(),
    mockEnrichUserWithTheProfile: vi.fn(),
    mockIsOrganizationsEnabled: vi.fn(),
  }));

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    findUnlockedUserForSession = (...args: unknown[]) => mockFindUnlockedUserForSession(...args);
    enrichUserWithTheProfile = (...args: unknown[]) => mockEnrichUserWithTheProfile(...args);
  },
}));

vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: { findByUserIdAndProfileId: vi.fn() },
}));

vi.mock("@calcom/prisma", () => ({ default: {} }));

vi.mock("@calcom/lib/organizations/isOrganizationsEnabled", () => ({
  isOrganizationsEnabled: () => mockIsOrganizationsEnabled(),
}));

vi.mock("@calcom/lib/constants", () => ({ WEBAPP_URL: "http://localhost:3000", IS_PRODUCTION: false }));

import { getUserSession } from "./userFromSessionUtils";

const session = {
  user: { id: 1 },
  upId: "usr-1",
  hasValidLicense: true,
  expires: "2099-01-01T00:00:00.000Z",
} as Session;

function mockUser({
  dbOrganizationId,
  profileOrganization,
}: {
  dbOrganizationId: number | null;
  profileOrganization: { id: number; slug: string; members: { role: string }[] } | null;
}) {
  const userFromDb = {
    id: 1,
    uuid: "uuid-1",
    username: "member",
    email: "member@example.com",
    metadata: {},
    locale: "en",
    requiresBookerEmailVerification: false,
    organizationId: dbOrganizationId,
  };
  mockFindUnlockedUserForSession.mockResolvedValue(userFromDb);
  mockEnrichUserWithTheProfile.mockResolvedValue({
    ...userFromDb,
    profile: profileOrganization
      ? { organizationId: profileOrganization.id, organization: profileOrganization }
      : { organizationId: null, organization: null },
  });
}

describe("getUserSession organizationId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOrganizationsEnabled.mockReturnValue(true);
  });

  it("uses the profile organization id when the profile has one", async () => {
    mockUser({ dbOrganizationId: 9, profileOrganization: { id: 3, slug: "acme", members: [] } });

    const { user } = await getUserSession({ session });

    expect(user?.organizationId).toBe(3);
    expect(user?.organization.id).toBe(3);
  });

  it("falls back to the DB organizationId when there is no profile organization and the flag is on", async () => {
    mockUser({ dbOrganizationId: 5, profileOrganization: null });

    const { user } = await getUserSession({ session });

    expect(user?.organizationId).toBe(5);
    expect(user?.organization.id).toBeNull();
  });

  it("ignores the DB organizationId when organizations are disabled", async () => {
    mockIsOrganizationsEnabled.mockReturnValue(false);
    mockUser({ dbOrganizationId: 5, profileOrganization: null });

    const { user } = await getUserSession({ session });

    expect(user?.organizationId).toBeNull();
  });

  it("returns null when neither the profile nor the user has an organization", async () => {
    mockUser({ dbOrganizationId: null, profileOrganization: null });

    const { user } = await getUserSession({ session });

    expect(user?.organizationId).toBeNull();
  });
});
