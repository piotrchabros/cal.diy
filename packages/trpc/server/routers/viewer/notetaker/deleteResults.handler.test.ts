import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteResultsHandler } from "./deleteResults.handler";
import { ZDeleteResultsInputSchema } from "./deleteResults.schema";

const mocks = vi.hoisted(() => ({
  deleteResults: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => ({ getState: mocks.getState }),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerResultsService.container", () => ({
  getNotetakerResultsService: () => ({ deleteResults: mocks.deleteResults }),
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
  status: "READY",
  canToggle: false,
  canStop: false,
  isRecurring: false,
  session: {
    id: "session-1",
    status: "READY",
    outcomeReason: null,
    startedLate: false,
    joinRequestedAt: "2026-01-01T10:00:00.000Z",
    admittedAt: "2026-01-01T10:01:00.000Z",
    endedAt: "2026-01-01T10:45:00.000Z",
    interruptedAtMs: null,
    resultsDeletedAt: "2026-01-01T11:00:00.000Z",
  },
  transcript: null,
  summary: null,
  sharedWithAttendees: false,
};

const run = () =>
  deleteResultsHandler({ ctx: { user }, input: ZDeleteResultsInputSchema.parse({ bookingUid }) });

describe("deleteResultsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteResults.mockResolvedValue(undefined);
    mocks.getState.mockResolvedValue(state);
  });

  it("calls deleteResults once with the booking uid and the user id taken from ctx", async () => {
    await run();

    expect(mocks.deleteResults).toHaveBeenCalledTimes(1);
    expect(mocks.deleteResults).toHaveBeenCalledWith({ bookingUid, userId: 7 });
  });

  it("returns the state read from getState for the ctx user", async () => {
    const result = await run();

    expect(result).toBe(state);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.getState).toHaveBeenCalledWith({ bookingUid, userId: 7 });
  });

  it("reads the state after deleting the results", async () => {
    await run();

    const deleteOrder = mocks.deleteResults.mock.invocationCallOrder[0];
    const getStateOrder = mocks.getState.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(getStateOrder);
  });

  it("does not read the state while deleteResults is still pending", async () => {
    let resolveDelete: () => void = () => {};
    mocks.deleteResults.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      })
    );

    const pending = run();
    await Promise.resolve();
    expect(mocks.getState).not.toHaveBeenCalled();

    resolveDelete();
    await pending;
    expect(mocks.getState).toHaveBeenCalledTimes(1);
  });

  it("propagates a Forbidden ErrorWithCode from deleteResults unchanged and does not read the state", async () => {
    const error = ErrorWithCode.Factory.Forbidden("forbidden");
    mocks.deleteResults.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates a NotFound ErrorWithCode from deleteResults unchanged and does not read the state", async () => {
    const error = ErrorWithCode.Factory.NotFound("not found");
    mocks.deleteResults.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates a BadRequest ErrorWithCode from deleteResults unchanged and does not read the state", async () => {
    const error = ErrorWithCode.Factory.BadRequest("bad request");
    mocks.deleteResults.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("propagates an ErrorWithCode from getState unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("not allowed");
    mocks.getState.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
  });
});

describe("ZDeleteResultsInputSchema", () => {
  it("rejects a missing bookingUid", () => {
    expect(ZDeleteResultsInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string bookingUid", () => {
    expect(ZDeleteResultsInputSchema.safeParse({ bookingUid: 5 }).success).toBe(false);
  });

  it("accepts a string bookingUid", () => {
    expect(ZDeleteResultsInputSchema.safeParse({ bookingUid }).success).toBe(true);
  });
});
