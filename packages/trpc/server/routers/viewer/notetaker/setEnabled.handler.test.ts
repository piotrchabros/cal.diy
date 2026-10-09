import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEnabledHandler } from "./setEnabled.handler";
import { ZSetEnabledInputSchema } from "./setEnabled.schema";

const mocks = vi.hoisted(() => ({
  setEnabled: vi.fn(),
  getState: vi.fn(),
  dispatchForBooking: vi.fn(),
  stopForBooking: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => ({ setEnabled: mocks.setEnabled, getState: mocks.getState }),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerDispatchService.container", () => ({
  getNotetakerDispatchService: () => ({
    dispatchForBooking: mocks.dispatchForBooking,
    stopForBooking: mocks.stopForBooking,
  }),
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

const run = (input: { enabled: boolean; scope?: "THIS_BOOKING" | "ALL_FUTURE_OCCURRENCES" }) =>
  setEnabledHandler({ ctx: { user }, input: ZSetEnabledInputSchema.parse({ bookingUid, ...input }) });

describe("setEnabledHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setEnabled.mockResolvedValue(undefined);
    mocks.dispatchForBooking.mockResolvedValue(undefined);
    mocks.stopForBooking.mockResolvedValue(undefined);
    mocks.getState.mockResolvedValue(state);
  });

  it("calls setEnabled once with the user id taken from ctx", async () => {
    await run({ enabled: true });

    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
    expect(mocks.setEnabled).toHaveBeenCalledWith({
      bookingUid,
      enabled: true,
      scope: "THIS_BOOKING",
      userId: 7,
    });
  });

  it("dispatches the booking when enabled and does not stop it", async () => {
    await run({ enabled: true });

    expect(mocks.dispatchForBooking).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchForBooking).toHaveBeenCalledWith({ bookingUid });
    expect(mocks.stopForBooking).not.toHaveBeenCalled();
  });

  it("stops the booking with reason DISABLED when disabled and does not dispatch it", async () => {
    await run({ enabled: false });

    expect(mocks.stopForBooking).toHaveBeenCalledTimes(1);
    expect(mocks.stopForBooking).toHaveBeenCalledWith({ bookingUid, reason: "DISABLED" });
    expect(mocks.dispatchForBooking).not.toHaveBeenCalled();
  });

  it("returns the state read from getState for the ctx user", async () => {
    const result = await run({ enabled: true });

    expect(result).toBe(state);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.getState).toHaveBeenCalledWith({ bookingUid, userId: 7 });
  });

  it("reads the state after dispatching on the enable path", async () => {
    await run({ enabled: true });

    const setEnabledOrder = mocks.setEnabled.mock.invocationCallOrder[0];
    const dispatchOrder = mocks.dispatchForBooking.mock.invocationCallOrder[0];
    const getStateOrder = mocks.getState.mock.invocationCallOrder[0];
    expect(setEnabledOrder).toBeLessThan(dispatchOrder);
    expect(dispatchOrder).toBeLessThan(getStateOrder);
  });

  it("reads the state after stopping on the disable path", async () => {
    await run({ enabled: false });

    const setEnabledOrder = mocks.setEnabled.mock.invocationCallOrder[0];
    const stopOrder = mocks.stopForBooking.mock.invocationCallOrder[0];
    const getStateOrder = mocks.getState.mock.invocationCallOrder[0];
    expect(setEnabledOrder).toBeLessThan(stopOrder);
    expect(stopOrder).toBeLessThan(getStateOrder);
  });

  it("propagates an ErrorWithCode from setEnabled unchanged and does nothing further", async () => {
    const error = ErrorWithCode.Factory.BadRequest("CAL_VIDEO", { reason: "CAL_VIDEO" });
    mocks.setEnabled.mockRejectedValue(error);

    await expect(run({ enabled: true })).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(error.message).toBe("CAL_VIDEO");
    expect(mocks.dispatchForBooking).not.toHaveBeenCalled();
    expect(mocks.stopForBooking).not.toHaveBeenCalled();
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates an ErrorWithCode from dispatchForBooking and does not read the state", async () => {
    const error = ErrorWithCode.Factory.InternalServerError("dispatch failed");
    mocks.dispatchForBooking.mockRejectedValue(error);

    await expect(run({ enabled: true })).rejects.toBe(error);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates an ErrorWithCode from stopForBooking and does not read the state", async () => {
    const error = ErrorWithCode.Factory.InternalServerError("stop failed");
    mocks.stopForBooking.mockRejectedValue(error);

    await expect(run({ enabled: false })).rejects.toBe(error);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates an ErrorWithCode from getState unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("not allowed");
    mocks.getState.mockRejectedValue(error);

    await expect(run({ enabled: true })).rejects.toBe(error);
  });

  it("defaults the scope to THIS_BOOKING and forwards it to setEnabled", async () => {
    const input = ZSetEnabledInputSchema.parse({ bookingUid, enabled: true });
    expect(input.scope).toBe("THIS_BOOKING");

    await setEnabledHandler({ ctx: { user }, input });

    expect(mocks.setEnabled).toHaveBeenCalledWith(expect.objectContaining({ scope: "THIS_BOOKING" }));
  });

  it("passes ALL_FUTURE_OCCURRENCES through unchanged", async () => {
    await run({ enabled: true, scope: "ALL_FUTURE_OCCURRENCES" });

    expect(mocks.setEnabled).toHaveBeenCalledWith({
      bookingUid,
      enabled: true,
      scope: "ALL_FUTURE_OCCURRENCES",
      userId: 7,
    });
  });
});

describe("ZSetEnabledInputSchema", () => {
  it("rejects a missing enabled", () => {
    expect(ZSetEnabledInputSchema.safeParse({ bookingUid }).success).toBe(false);
  });

  it("rejects an unknown scope", () => {
    expect(ZSetEnabledInputSchema.safeParse({ bookingUid, enabled: true, scope: "EVERYTHING" }).success).toBe(
      false
    );
  });
});
