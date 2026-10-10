import type { NotetakerEventTypeSharingDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEventTypeSharingHandler } from "./getEventTypeSharing.handler";
import { ZGetEventTypeSharingInputSchema } from "./getEventTypeSharing.schema";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerSharingSettingsService.container", () => ({
  getNotetakerSharingSettingsService: () => ({ get: mocks.get }),
}));

const eventTypeId = 42;
const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerEventTypeSharingDto = {
  eventTypeId,
  available: true,
  unavailableReason: null,
  mode: "TEAM",
  teamName: "Sales",
  people: [],
  setAt: null,
  setByName: null,
};
const run = () =>
  getEventTypeSharingHandler({
    ctx: { user },
    input: ZGetEventTypeSharingInputSchema.parse({ eventTypeId }),
  });

describe("getEventTypeSharingHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(dto);
  });

  it("calls get once with the event type id and the user id taken from ctx", async () => {
    await run();

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith({ eventTypeId: 42, userId: 7 });
  });

  it("returns the DTO from the service unchanged", async () => {
    expect(await run()).toBe(dto);
  });

  it("propagates an ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("EVENT_TYPE_NOT_FOUND");
    mocks.get.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZGetEventTypeSharingInputSchema", () => {
  it("rejects a missing eventTypeId", () => {
    expect(ZGetEventTypeSharingInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-integer eventTypeId", () => {
    expect(ZGetEventTypeSharingInputSchema.safeParse({ eventTypeId: 1.5 }).success).toBe(false);
  });

  it("rejects a string eventTypeId", () => {
    expect(ZGetEventTypeSharingInputSchema.safeParse({ eventTypeId: "42" }).success).toBe(false);
  });

  it("accepts an integer eventTypeId", () => {
    expect(ZGetEventTypeSharingInputSchema.safeParse({ eventTypeId }).success).toBe(true);
  });
});
