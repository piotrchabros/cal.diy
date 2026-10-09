import type { NotetakerActivityDto } from "@calcom/lib/dto/NotetakerActivityDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActivityHandler } from "./getActivity.handler";
import { ZGetActivityInputSchema } from "./getActivity.schema";

const mocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerResultsService.container", () => ({
  getNotetakerResultsService: () => ({ getActivity: mocks.getActivity }),
}));

const bookingUid = "booking-uid-1";
const user = { id: 7 } as NonNullable<TrpcSessionUser>;

const activity: NotetakerActivityDto[] = [
  {
    id: "activity-1",
    action: "SHARED",
    actorType: "USER",
    actorName: "Host Name",
    createdAt: "2026-01-01T10:00:00.000Z",
    detail: null,
  },
];

const run = () => getActivityHandler({ ctx: { user }, input: ZGetActivityInputSchema.parse({ bookingUid }) });

describe("getActivityHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActivity.mockResolvedValue(activity);
  });

  it("calls getActivity once with the booking uid and the user id taken from ctx", async () => {
    await run();

    expect(mocks.getActivity).toHaveBeenCalledTimes(1);
    expect(mocks.getActivity).toHaveBeenCalledWith({ bookingUid, userId: 7 });
  });

  it("returns the activity read from getActivity", async () => {
    const result = await run();

    expect(result).toBe(activity);
  });

  it("propagates a Forbidden ErrorWithCode from getActivity unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("forbidden");
    mocks.getActivity.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a NotFound ErrorWithCode from getActivity unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("not found");
    mocks.getActivity.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a BadRequest ErrorWithCode from getActivity unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("bad request");
    mocks.getActivity.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZGetActivityInputSchema", () => {
  it("rejects a missing bookingUid", () => {
    expect(ZGetActivityInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string bookingUid", () => {
    expect(ZGetActivityInputSchema.safeParse({ bookingUid: 5 }).success).toBe(false);
  });

  it("accepts a string bookingUid", () => {
    expect(ZGetActivityInputSchema.safeParse({ bookingUid }).success).toBe(true);
  });
});
