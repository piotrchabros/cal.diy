import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertUserCanBeDeleted, deleteUser } from "./deleteUser";

const mocks = vi.hoisted(() => ({
  assertUserCanBeDeleted: vi.fn(),
  deleteById: vi.fn(),
  deleteStripeCustomer: vi.fn(),
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ assertUserCanBeDeleted: mocks.assertUserCanBeDeleted }),
}));

vi.mock("@calcom/features/di/containers/UserRepository", () => ({
  getUserRepository: () => ({ deleteById: mocks.deleteById }),
}));

vi.mock("@calcom/app-store/stripepayment/lib/customer", () => ({
  deleteStripeCustomer: mocks.deleteStripeCustomer,
}));

const user = { id: 7, email: "owner@acme.com", metadata: null };

describe("deleteUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertUserCanBeDeleted.mockResolvedValue(undefined);
    mocks.deleteById.mockResolvedValue(undefined);
    mocks.deleteStripeCustomer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("checks the last-owner rule, removes the Stripe customer and deletes through the repository", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await deleteUser(user);

    expect(mocks.assertUserCanBeDeleted).toHaveBeenCalledWith(7);
    expect(mocks.deleteStripeCustomer).toHaveBeenCalledWith(user);
    expect(mocks.deleteById).toHaveBeenCalledWith({ id: 7 });
  });

  it("deletes nothing when the user is the last owner of their organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    const refusal = ErrorWithCode.Factory.PreconditionFailed("organization_last_owner_cannot_be_deleted");
    mocks.assertUserCanBeDeleted.mockRejectedValue(refusal);

    await expect(deleteUser(user)).rejects.toBe(refusal);
    expect(mocks.deleteStripeCustomer).not.toHaveBeenCalled();
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it("still deletes the user when removing the Stripe customer fails", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.deleteStripeCustomer.mockRejectedValue(new Error("stripe down"));

    await deleteUser(user);

    expect(mocks.deleteById).toHaveBeenCalledWith({ id: 7 });
    warn.mockRestore();
  });

  it("skips the last-owner rule while organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");

    await assertUserCanBeDeleted(7);
    await deleteUser(user);

    expect(mocks.assertUserCanBeDeleted).not.toHaveBeenCalled();
    expect(mocks.deleteById).toHaveBeenCalledWith({ id: 7 });
  });
});
