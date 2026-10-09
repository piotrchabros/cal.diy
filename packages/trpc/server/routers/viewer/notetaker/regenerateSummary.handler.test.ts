import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { regenerateSummaryHandler } from "./regenerateSummary.handler";
import { ZRegenerateSummaryInputSchema } from "./regenerateSummary.schema";

const mocks = vi.hoisted(() => ({
  requestRegeneration: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerSummaryService.container", () => ({
  getNotetakerSummaryService: () => ({ requestRegeneration: mocks.requestRegeneration }),
}));

const bookingUid = "booking-uid-1";
const user = { id: 7 } as NonNullable<TrpcSessionUser>;

const summary: NotetakerSummaryDto = {
  status: "PENDING",
  language: null,
  overview: null,
  keyPoints: [],
  decisions: [],
  actionItems: [],
  generatedAt: null,
};

const run = () =>
  regenerateSummaryHandler({ ctx: { user }, input: ZRegenerateSummaryInputSchema.parse({ bookingUid }) });

describe("regenerateSummaryHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestRegeneration.mockResolvedValue(summary);
  });

  it("calls requestRegeneration once with the booking uid and the user id taken from ctx", async () => {
    await run();

    expect(mocks.requestRegeneration).toHaveBeenCalledTimes(1);
    expect(mocks.requestRegeneration).toHaveBeenCalledWith({ bookingUid, userId: 7 });
  });

  it("returns the summary from requestRegeneration unchanged", async () => {
    const result = await run();

    expect(result).toBe(summary);
  });

  it("propagates a Forbidden ErrorWithCode from requestRegeneration unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("forbidden");
    mocks.requestRegeneration.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a NotFound ErrorWithCode from requestRegeneration unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("not found");
    mocks.requestRegeneration.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a BadRequest ErrorWithCode from requestRegeneration unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest(
      "Summary of booking booking-uid-1 is READY and cannot be regenerated"
    );
    mocks.requestRegeneration.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(error.message).toBe("Summary of booking booking-uid-1 is READY and cannot be regenerated");
  });
});

describe("ZRegenerateSummaryInputSchema", () => {
  it("rejects a missing bookingUid", () => {
    expect(ZRegenerateSummaryInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-string bookingUid", () => {
    expect(ZRegenerateSummaryInputSchema.safeParse({ bookingUid: 5 }).success).toBe(false);
  });

  it("accepts a string bookingUid", () => {
    expect(ZRegenerateSummaryInputSchema.safeParse({ bookingUid }).success).toBe(true);
  });
});
