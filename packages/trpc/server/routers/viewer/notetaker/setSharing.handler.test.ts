import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSharingHandler } from "./setSharing.handler";
import { ZSetSharingInputSchema } from "./setSharing.schema";

const mocks = vi.hoisted(() => ({
  setSharing: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerResultsService.container", () => ({
  getNotetakerResultsService: () => ({ setSharing: mocks.setSharing }),
}));

const bookingUid = "booking-uid-1";
const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const result = { sharedWithAttendees: true };

const run = (shared = true) =>
  setSharingHandler({ ctx: { user }, input: ZSetSharingInputSchema.parse({ bookingUid, shared }) });

describe("setSharingHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setSharing.mockResolvedValue(result);
  });

  it("calls setSharing once with the booking uid, the shared flag and the user id taken from ctx", async () => {
    await run();

    expect(mocks.setSharing).toHaveBeenCalledTimes(1);
    expect(mocks.setSharing).toHaveBeenCalledWith({ bookingUid, shared: true, userId: 7 });
  });

  it("passes shared false through", async () => {
    await run(false);

    expect(mocks.setSharing).toHaveBeenCalledWith({ bookingUid, shared: false, userId: 7 });
  });

  it("returns the service result unchanged", async () => {
    expect(await run()).toBe(result);
  });

  it("propagates a Forbidden ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("forbidden");
    mocks.setSharing.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a NotFound ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("not found");
    mocks.setSharing.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a BadRequest ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("bad request");
    mocks.setSharing.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZSetSharingInputSchema", () => {
  it("rejects a missing bookingUid", () => {
    expect(ZSetSharingInputSchema.safeParse({ shared: true }).success).toBe(false);
  });

  it("rejects a non-string bookingUid", () => {
    expect(ZSetSharingInputSchema.safeParse({ bookingUid: 5, shared: true }).success).toBe(false);
  });

  it("rejects a non-boolean shared", () => {
    expect(ZSetSharingInputSchema.safeParse({ bookingUid, shared: "true" }).success).toBe(false);
  });

  it("rejects a missing shared", () => {
    expect(ZSetSharingInputSchema.safeParse({ bookingUid }).success).toBe(false);
  });

  it("accepts a string bookingUid with shared false", () => {
    expect(ZSetSharingInputSchema.safeParse({ bookingUid, shared: false }).success).toBe(true);
  });
});
