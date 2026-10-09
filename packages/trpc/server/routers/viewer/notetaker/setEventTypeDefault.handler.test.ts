import type { NotetakerEventTypeDefaultDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEventTypeDefaultHandler } from "./setEventTypeDefault.handler";
import { ZSetEventTypeDefaultInputSchema } from "./setEventTypeDefault.schema";

const mocks = vi.hoisted(() => ({ setEventTypeDefault: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerChoiceService.container", () => ({
  getNotetakerChoiceService: () => ({ setEventTypeDefault: mocks.setEventTypeDefault }),
}));

const eventTypeId = 42;
const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerEventTypeDefaultDto = {
  enabledByDefault: true,
  available: true,
  unavailableReason: null,
};
const run = (enabledByDefault: boolean) =>
  setEventTypeDefaultHandler({
    ctx: { user },
    input: ZSetEventTypeDefaultInputSchema.parse({ eventTypeId, enabledByDefault }),
  });

describe("setEventTypeDefaultHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setEventTypeDefault.mockResolvedValue(dto);
  });

  it("calls setEventTypeDefault once with the input and the user id taken from ctx", async () => {
    await run(true);

    expect(mocks.setEventTypeDefault).toHaveBeenCalledTimes(1);
    expect(mocks.setEventTypeDefault).toHaveBeenCalledWith({
      eventTypeId: 42,
      enabledByDefault: true,
      userId: 7,
    });
  });

  it("passes enabledByDefault false through", async () => {
    await run(false);

    expect(mocks.setEventTypeDefault).toHaveBeenCalledWith({
      eventTypeId: 42,
      enabledByDefault: false,
      userId: 7,
    });
  });

  it("returns the DTO from the service unchanged", async () => {
    expect(await run(true)).toBe(dto);
  });

  it("propagates a NotFound ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("EVENT_TYPE_NOT_FOUND");
    mocks.setEventTypeDefault.mockRejectedValue(error);

    await expect(run(true)).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates the BadRequest carrying the reason code unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("UNSUPPORTED_PLATFORM", {
      reason: "UNSUPPORTED_PLATFORM",
    });
    mocks.setEventTypeDefault.mockRejectedValue(error);

    await expect(run(true)).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect(error.message).toBe("UNSUPPORTED_PLATFORM");
    expect(error.data).toEqual({ reason: "UNSUPPORTED_PLATFORM" });
  });
});

describe("ZSetEventTypeDefaultInputSchema", () => {
  it("rejects a missing eventTypeId", () => {
    expect(ZSetEventTypeDefaultInputSchema.safeParse({ enabledByDefault: true }).success).toBe(false);
  });

  it("rejects a non-integer eventTypeId", () => {
    expect(
      ZSetEventTypeDefaultInputSchema.safeParse({ eventTypeId: 1.5, enabledByDefault: true }).success
    ).toBe(false);
  });

  it("rejects a missing enabledByDefault", () => {
    expect(ZSetEventTypeDefaultInputSchema.safeParse({ eventTypeId }).success).toBe(false);
  });

  it("rejects a non-boolean enabledByDefault", () => {
    expect(ZSetEventTypeDefaultInputSchema.safeParse({ eventTypeId, enabledByDefault: "true" }).success).toBe(
      false
    );
  });

  it("accepts an integer eventTypeId and a boolean enabledByDefault", () => {
    expect(ZSetEventTypeDefaultInputSchema.safeParse({ eventTypeId, enabledByDefault: false }).success).toBe(
      true
    );
  });
});
