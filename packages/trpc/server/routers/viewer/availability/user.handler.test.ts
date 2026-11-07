import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUsersForAvailabilityCheck, getUserAvailabilityIncludingBusyTimesFromLimits } = vi.hoisted(() => ({
  findUsersForAvailabilityCheck: vi.fn(),
  getUserAvailabilityIncludingBusyTimesFromLimits: vi.fn(),
}));

vi.mock("@calcom/features/availability/lib/findUsersForAvailabilityCheck", () => ({
  findUsersForAvailabilityCheck,
}));

vi.mock("@calcom/features/di/containers/GetUserAvailability", () => ({
  getUserAvailabilityService: () => ({ getUserAvailabilityIncludingBusyTimesFromLimits }),
}));

import dayjs from "@calcom/dayjs";
import type { TrpcSessionUser } from "../../../types";
import { userHandler } from "./user.handler";

const sessionUser = { id: 7, username: "jan", organizationId: 100 } as NonNullable<TrpcSessionUser>;
const range = { dateFrom: dayjs("2026-11-01T00:00:00Z"), dateTo: dayjs("2026-11-02T00:00:00Z") };

describe("availability userHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserAvailabilityIncludingBusyTimesFromLimits.mockResolvedValue({ busy: [] });
  });

  it("looks the caller up by id when they ask for their own username", async () => {
    const self = { id: 7, username: "jan" };
    findUsersForAvailabilityCheck.mockResolvedValue(self);

    const result = await userHandler({ ctx: { user: sessionUser }, input: { username: "jan", ...range } });

    expect(findUsersForAvailabilityCheck).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(getUserAvailabilityIncludingBusyTimesFromLimits).toHaveBeenCalledWith(
      expect.objectContaining({ username: "jan", returnDateOverrides: true, bypassBusyCalendarTimes: false }),
      { user: self }
    );
    expect(result).toEqual({ busy: [] });
  });

  it("scopes another username to the caller's organization", async () => {
    findUsersForAvailabilityCheck.mockResolvedValue({ id: 8, username: "ola" });

    await userHandler({ ctx: { user: sessionUser }, input: { username: "ola", ...range } });

    expect(findUsersForAvailabilityCheck).toHaveBeenCalledWith({
      where: { username: "ola", organizationId: 100 },
    });
  });

  it("answers NOT_FOUND when the username only exists in another organization", async () => {
    findUsersForAvailabilityCheck.mockResolvedValue(null);

    await expect(
      userHandler({ ctx: { user: sessionUser }, input: { username: "ola", ...range } })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getUserAvailabilityIncludingBusyTimesFromLimits).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for another username when the caller has no organization", async () => {
    const user = { ...sessionUser, organizationId: null } as NonNullable<TrpcSessionUser>;

    await expect(userHandler({ ctx: { user }, input: { username: "ola", ...range } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(findUsersForAvailabilityCheck).not.toHaveBeenCalled();
  });
});
