import { beforeEach, describe, expect, it, vi } from "vitest";

const { findForAvailabilityCheck, enrich } = vi.hoisted(() => ({
  findForAvailabilityCheck: vi.fn(),
  enrich: vi.fn(),
}));

vi.mock("@calcom/features/di/containers/UserRepository", () => ({
  getUserRepository: () => ({ findForAvailabilityCheck }),
}));

vi.mock("@calcom/app-store/delegationCredential", () => ({
  enrichUserWithDelegationCredentialsIncludeServiceAccountKey: enrich,
}));

import { findUsersForAvailabilityCheck } from "./findUsersForAvailabilityCheck";

describe("findUsersForAvailabilityCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without enriching when the repository finds nobody", async () => {
    findForAvailabilityCheck.mockResolvedValue(null);

    const result = await findUsersForAvailabilityCheck({ where: { username: "jan", organizationId: 1 } });

    expect(result).toBeNull();
    expect(findForAvailabilityCheck).toHaveBeenCalledWith({ username: "jan", organizationId: 1 });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("enriches the found user with delegation credentials", async () => {
    const user = { id: 7, credentials: [] };
    findForAvailabilityCheck.mockResolvedValue(user);
    enrich.mockResolvedValue({ ...user, enriched: true });

    const result = await findUsersForAvailabilityCheck({ where: { id: 7 } });

    expect(findForAvailabilityCheck).toHaveBeenCalledWith({ id: 7 });
    expect(enrich).toHaveBeenCalledWith({ user });
    expect(result).toEqual({ ...user, enriched: true });
  });
});
