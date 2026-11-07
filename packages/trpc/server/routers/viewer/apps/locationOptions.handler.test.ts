import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getLocationGroupedOptions, canViewTeam } = vi.hoisted(() => ({
  getLocationGroupedOptions: vi.fn(),
  canViewTeam: vi.fn(),
}));

vi.mock("@calcom/app-store/server", () => ({ getLocationGroupedOptions }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: async () => (key: string) => key }));
vi.mock("@calcom/features/teams/di/TeamAccessService.container", () => ({
  getTeamAccessService: () => ({ canViewTeam }),
}));

import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { locationOptionsHandler } from "./locationOptions.handler";

const ctx = { user: { id: 7, locale: "en" } as NonNullable<TrpcSessionUser> };

describe("locationOptionsHandler", () => {
  beforeEach(() => {
    getLocationGroupedOptions.mockResolvedValue([
      { label: "Other", options: [] },
      { label: "Conferencing", options: [] },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("lists the caller's own options without a team check", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await locationOptionsHandler({ ctx, input: {} });

    expect(canViewTeam).not.toHaveBeenCalled();
    expect(getLocationGroupedOptions).toHaveBeenCalledWith({ userId: 7 }, expect.any(Function));
  });

  it("answers NOT_FOUND for a team the caller cannot see when organizations are on", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    canViewTeam.mockResolvedValue(false);

    await expect(locationOptionsHandler({ ctx, input: { teamId: 42 } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(canViewTeam).toHaveBeenCalledWith({ userId: 7, teamId: 42 });
    expect(getLocationGroupedOptions).not.toHaveBeenCalled();
  });

  it("lists a visible team's options with conferencing first", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    canViewTeam.mockResolvedValue(true);

    const result = await locationOptionsHandler({ ctx, input: { teamId: 42 } });

    expect(getLocationGroupedOptions).toHaveBeenCalledWith({ teamId: 42 }, expect.any(Function));
    expect(result.map((group) => group.label)).toEqual(["Conferencing", "Other"]);
  });

  it("keeps the previous behaviour when organizations are off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await locationOptionsHandler({ ctx, input: { teamId: 42 } });

    expect(canViewTeam).not.toHaveBeenCalled();
    expect(getLocationGroupedOptions).toHaveBeenCalledWith({ teamId: 42 }, expect.any(Function));
  });
});
