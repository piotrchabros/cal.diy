import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findByOrgIdAndUsername, findManyByOrgSlugOrRequestedSlug, isUsernameReservedDueToMigration } =
  vi.hoisted(() => ({
    findByOrgIdAndUsername: vi.fn(),
    findManyByOrgSlugOrRequestedSlug: vi.fn(),
    isUsernameReservedDueToMigration: vi.fn(),
  }));

vi.mock("@calcom/features/profile/repositories/ProfileRepository", () => ({
  ProfileRepository: { findByOrgIdAndUsername, findManyByOrgSlugOrRequestedSlug },
}));

vi.mock("@calcom/lib/server/username", () => ({ isUsernameReservedDueToMigration }));

import { checkRegularUsername } from "./checkRegularUsername";

const takenMessage = "A user exists with that username";

describe("checkRegularUsername", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_IS_E2E", "");
    findByOrgIdAndUsername.mockResolvedValue(null);
    findManyByOrgSlugOrRequestedSlug.mockResolvedValue([]);
    isUsernameReservedDueToMigration.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("organizationId namespace", () => {
    it("reports a username taken in the organization", async () => {
      findByOrgIdAndUsername.mockResolvedValue({ id: 1, user: { id: 10 } });

      await expect(checkRegularUsername("alice", { organizationId: 7 })).resolves.toEqual({
        available: false,
        premium: false,
        message: takenMessage,
      });
      expect(findByOrgIdAndUsername).toHaveBeenCalledWith({ organizationId: 7, username: "alice" });
    });

    it("reports a free username without checking migration reservations", async () => {
      isUsernameReservedDueToMigration.mockResolvedValue(true);

      await expect(checkRegularUsername("alice", { organizationId: 7 })).resolves.toEqual({
        available: true,
        premium: false,
      });
      expect(isUsernameReservedDueToMigration).not.toHaveBeenCalled();
      expect(findManyByOrgSlugOrRequestedSlug).not.toHaveBeenCalled();
    });
  });

  describe("orgSlug namespace", () => {
    it("reports a username taken in the organization", async () => {
      findManyByOrgSlugOrRequestedSlug.mockResolvedValue([{ id: 1, user: { id: 10 } }]);

      await expect(checkRegularUsername("alice", { orgSlug: "acme" })).resolves.toEqual({
        available: false,
        premium: false,
        message: takenMessage,
      });
      expect(findManyByOrgSlugOrRequestedSlug).toHaveBeenCalledWith({
        orgSlug: "acme",
        usernames: ["alice"],
      });
    });

    it("reports a free username without checking migration reservations", async () => {
      isUsernameReservedDueToMigration.mockResolvedValue(true);

      await expect(checkRegularUsername("alice", { orgSlug: "acme" })).resolves.toEqual({
        available: true,
        premium: false,
      });
      expect(isUsernameReservedDueToMigration).not.toHaveBeenCalled();
      expect(findByOrgIdAndUsername).not.toHaveBeenCalled();
    });
  });

  describe("global namespace", () => {
    it("reports a username reserved due to migration as unavailable", async () => {
      isUsernameReservedDueToMigration.mockResolvedValue(true);

      await expect(checkRegularUsername("alice")).resolves.toEqual({ available: false, premium: false });
      expect(isUsernameReservedDueToMigration).toHaveBeenCalledWith("alice");
    });

    it("reports an unreserved username as available without querying profiles", async () => {
      await expect(checkRegularUsername("alice", null)).resolves.toEqual({ available: true, premium: false });
      expect(findByOrgIdAndUsername).not.toHaveBeenCalled();
      expect(findManyByOrgSlugOrRequestedSlug).not.toHaveBeenCalled();
    });
  });

  it("slugifies the input before looking it up", async () => {
    await checkRegularUsername("Alice Smith", { organizationId: 7 });

    expect(findByOrgIdAndUsername).toHaveBeenCalledWith({ organizationId: 7, username: "alice-smith" });
  });

  describe("premium flag", () => {
    it("marks short usernames as premium in E2E", async () => {
      vi.stubEnv("NEXT_PUBLIC_IS_E2E", "1");

      await expect(checkRegularUsername("abcd")).resolves.toEqual({ available: true, premium: true });
    });

    it("does not mark usernames of five or more characters as premium in E2E", async () => {
      vi.stubEnv("NEXT_PUBLIC_IS_E2E", "1");

      await expect(checkRegularUsername("abcde")).resolves.toEqual({ available: true, premium: false });
    });

    it("does not mark short usernames as premium outside E2E", async () => {
      await expect(checkRegularUsername("abcd")).resolves.toEqual({ available: true, premium: false });
    });
  });
});
