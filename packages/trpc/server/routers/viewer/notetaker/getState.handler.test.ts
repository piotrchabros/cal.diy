import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStateHandler } from "./getState.handler";
import { ZGetStateInputSchema } from "./getState.schema";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => ({ getState: mocks.getState }),
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

describe("getStateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockResolvedValue(state);
  });

  it("returns the state for the signed-in user", async () => {
    const result = await getStateHandler({ ctx: { user }, input: { bookingUid } });

    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.getState).toHaveBeenCalledWith({ bookingUid, userId: 7 });
    expect(result).toBe(state);
  });

  it("lets an ErrorWithCode from the service pass through unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("You cannot view this booking");
    mocks.getState.mockRejectedValue(error);

    await expect(getStateHandler({ ctx: { user }, input: { bookingUid } })).rejects.toBe(error);
  });
});

describe("ZGetStateInputSchema", () => {
  it("the schema requires a bookingUid", () => {
    expect(ZGetStateInputSchema.safeParse({}).success).toBe(false);
    expect(ZGetStateInputSchema.safeParse({ bookingUid }).success).toBe(true);
  });
});
