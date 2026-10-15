import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdHocOptionsHandler } from "./getAdHocOptions.handler";

const mocks = vi.hoisted(() => ({
  getOptions: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerAdHocService.container", () => ({
  getNotetakerAdHocService: () => ({ getOptions: mocks.getOptions }),
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const options = {
  featureEnabled: true,
  teamOptions: [],
  defaultDurationMinutes: 60,
  maxDurationMinutes: 240,
};

describe("getAdHocOptionsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptions.mockResolvedValue(options);
  });

  it("calls getOptions once with the user id taken from ctx", async () => {
    await getAdHocOptionsHandler({ ctx: { user } });

    expect(mocks.getOptions).toHaveBeenCalledTimes(1);
    expect(mocks.getOptions).toHaveBeenCalledWith({ userId: 7 });
  });

  it("returns the service result unchanged", async () => {
    expect(await getAdHocOptionsHandler({ ctx: { user } })).toBe(options);
  });

  it("propagates service errors unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("FEATURE_DISABLED");
    mocks.getOptions.mockRejectedValue(error);

    await expect(getAdHocOptionsHandler({ ctx: { user } })).rejects.toBe(error);
  });
});
