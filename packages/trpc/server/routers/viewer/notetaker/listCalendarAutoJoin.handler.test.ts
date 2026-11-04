import type { NotetakerCalendarAutoJoinSettingsDto } from "@calcom/lib/dto/NotetakerCalendarAutoJoinDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCalendarAutoJoinHandler } from "./listCalendarAutoJoin.handler";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerCalendarAutoJoinSettingsService.container", () => ({
  getNotetakerCalendarAutoJoinSettingsService: () => ({ list: mocks.list }),
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerCalendarAutoJoinSettingsDto = {
  available: true,
  teamOptions: [{ teamId: 3, name: "Sales" }],
  calendars: [
    {
      selectedCalendarId: "sc-1",
      integration: "google_calendar",
      externalId: "a@b.c",
      enabled: true,
      sharingTeamId: 3,
      supported: true,
      lastPollFailed: false,
    },
  ],
};

describe("listCalendarAutoJoinHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(dto);
  });

  it("calls list once with the user id taken from ctx", async () => {
    await listCalendarAutoJoinHandler({ ctx: { user } });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ userId: 7 });
  });

  it("returns the service result unchanged", async () => {
    expect(await listCalendarAutoJoinHandler({ ctx: { user } })).toBe(dto);
  });

  it("propagates service errors unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("nope");
    mocks.list.mockRejectedValue(error);

    await expect(listCalendarAutoJoinHandler({ ctx: { user } })).rejects.toBe(error);
  });
});
