import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopHandler } from "./stop.handler";
import { ZStopInputSchema } from "./stop.schema";

const mocks = vi.hoisted(() => ({
  stopForBooking: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => ({ getState: mocks.getState }),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerDispatchService.container", () => ({
  getNotetakerDispatchService: () => ({ stopForBooking: mocks.stopForBooking }),
}));

const bookingUid = "booking-uid-1";
const user = { id: 7 } as NonNullable<TrpcSessionUser>;

const state: NotetakerStateDto = {
  bookingUid,
  featureEnabled: true,
  viewerRole: "HOST",
  eligibility: { eligible: true, platform: "GOOGLE_MEET", reason: null },
  choice: {
    enabled: true,
    source: "HOST",
    appliedToSeries: false,
    setByName: "Host Name",
    setAt: "2026-01-01T10:00:00.000Z",
  },
  status: "SCHEDULED",
  canToggle: true,
  canStop: false,
  isRecurring: false,
  session: null,
  transcript: null,
  summary: null,
  sharedWithAttendees: false,
};

const run = () => stopHandler({ ctx: { user }, input: ZStopInputSchema.parse({ bookingUid }) });

describe("stopHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stopForBooking.mockResolvedValue(undefined);
    mocks.getState.mockResolvedValue(state);
  });

  it("calls stopForBooking once with the host reason and the user id taken from ctx", async () => {
    await run();

    expect(mocks.stopForBooking).toHaveBeenCalledTimes(1);
    expect(mocks.stopForBooking).toHaveBeenCalledWith({
      bookingUid,
      reason: "STOPPED_BY_HOST",
      userId: 7,
    });
  });

  it("returns the state read from getState for the ctx user", async () => {
    const result = await run();

    expect(result).toBe(state);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.getState).toHaveBeenCalledWith({ bookingUid, userId: 7 });
  });

  it("reads the state after stopping", async () => {
    await run();

    const stopOrder = mocks.stopForBooking.mock.invocationCallOrder[0];
    const getStateOrder = mocks.getState.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(getStateOrder);
  });

  it("propagates a Forbidden ErrorWithCode from stopForBooking unchanged and does not read the state", async () => {
    const error = ErrorWithCode.Factory.Forbidden("forbidden");
    mocks.stopForBooking.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates a NotFound ErrorWithCode from stopForBooking unchanged and does not read the state", async () => {
    const error = ErrorWithCode.Factory.NotFound("not found");
    mocks.stopForBooking.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates a BadRequest ErrorWithCode from stopForBooking unchanged and does not read the state", async () => {
    const error = ErrorWithCode.Factory.BadRequest("NO_ACTIVE_SESSION");
    mocks.stopForBooking.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(error.message).toBe("NO_ACTIVE_SESSION");
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates an ErrorWithCode from getState unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("not allowed");
    mocks.getState.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
  });
});

describe("ZStopInputSchema", () => {
  it("rejects a missing bookingUid", () => {
    expect(ZStopInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string bookingUid", () => {
    expect(ZStopInputSchema.safeParse({ bookingUid: 5 }).success).toBe(false);
  });

  it("accepts a string bookingUid", () => {
    expect(ZStopInputSchema.safeParse({ bookingUid }).success).toBe(true);
  });
});
