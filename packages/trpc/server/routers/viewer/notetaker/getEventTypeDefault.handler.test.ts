import type { NotetakerEventTypeDefaultDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEventTypeDefaultHandler } from "./getEventTypeDefault.handler";
import { ZGetEventTypeDefaultInputSchema } from "./getEventTypeDefault.schema";

const mocks = vi.hoisted(() => ({ getEventTypeDefault: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => ({ getEventTypeDefault: mocks.getEventTypeDefault }),
}));

const eventTypeId = 42;
const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerEventTypeDefaultDto = {
  enabledByDefault: true,
  available: true,
  unavailableReason: null,
};
const run = () =>
  getEventTypeDefaultHandler({
    ctx: { user },
    input: ZGetEventTypeDefaultInputSchema.parse({ eventTypeId }),
  });

describe("getEventTypeDefaultHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEventTypeDefault.mockResolvedValue(dto);
  });

  it("calls getEventTypeDefault once with the event type id and the user id taken from ctx", async () => {
    await run();

    expect(mocks.getEventTypeDefault).toHaveBeenCalledTimes(1);
    expect(mocks.getEventTypeDefault).toHaveBeenCalledWith({ eventTypeId: 42, userId: 7 });
  });

  it("returns the DTO from the service unchanged", async () => {
    expect(await run()).toBe(dto);
  });

  it("propagates a NotFound ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("EVENT_TYPE_NOT_FOUND");
    mocks.getEventTypeDefault.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(error.message).toBe("EVENT_TYPE_NOT_FOUND");
  });

  it("propagates a BadRequest ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("FEATURE_DISABLED", { reason: "FEATURE_DISABLED" });
    mocks.getEventTypeDefault.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZGetEventTypeDefaultInputSchema", () => {
  it("rejects a missing eventTypeId", () => {
    expect(ZGetEventTypeDefaultInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-integer eventTypeId", () => {
    expect(ZGetEventTypeDefaultInputSchema.safeParse({ eventTypeId: 1.5 }).success).toBe(false);
  });

  it("rejects a string eventTypeId", () => {
    expect(ZGetEventTypeDefaultInputSchema.safeParse({ eventTypeId: "42" }).success).toBe(false);
  });

  it("accepts an integer eventTypeId", () => {
    expect(ZGetEventTypeDefaultInputSchema.safeParse({ eventTypeId }).success).toBe(true);
  });
});
