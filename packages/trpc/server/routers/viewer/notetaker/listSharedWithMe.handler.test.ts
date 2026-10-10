import type { NotetakerSharedResultsDto } from "@calcom/lib/dto/NotetakerSharedResultDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSharedWithMeHandler } from "./listSharedWithMe.handler";
import { ZListSharedWithMeInputSchema } from "./listSharedWithMe.schema";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerSharedResultsService.container", () => ({
  getNotetakerSharedResultsService: () => ({ list: mocks.list }),
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerSharedResultsDto = { items: [], nextCursor: null };
const run = (input: unknown = {}) =>
  listSharedWithMeHandler({ ctx: { user }, input: ZListSharedWithMeInputSchema.parse(input) });

describe("listSharedWithMeHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(dto);
  });

  it("calls list once with the user id taken from ctx and the default limit", async () => {
    await run();

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ userId: 7, cursor: undefined, limit: 20 });
  });

  it("passes cursor and limit through", async () => {
    await run({ cursor: "2026-01-01T00:00:00.000Z|5", limit: 5 });

    expect(mocks.list).toHaveBeenCalledWith({
      userId: 7,
      cursor: "2026-01-01T00:00:00.000Z|5",
      limit: 5,
    });
  });

  it("returns the DTO from the service unchanged", async () => {
    expect(await run()).toBe(dto);
  });

  it("propagates an ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("INVALID_CURSOR");
    mocks.list.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZListSharedWithMeInputSchema", () => {
  it("defaults the limit to 20", () => {
    expect(ZListSharedWithMeInputSchema.parse({})).toEqual({ limit: 20 });
  });

  it.each([0, 51, 1.5])("rejects limit %s", (limit) => {
    expect(ZListSharedWithMeInputSchema.safeParse({ limit }).success).toBe(false);
  });

  it.each([1, 50])("accepts limit %s", (limit) => {
    expect(ZListSharedWithMeInputSchema.safeParse({ limit }).success).toBe(true);
  });

  it("rejects a cursor longer than 100 characters", () => {
    expect(ZListSharedWithMeInputSchema.safeParse({ cursor: "a".repeat(101) }).success).toBe(false);
  });

  it("accepts a cursor of 100 characters", () => {
    expect(ZListSharedWithMeInputSchema.safeParse({ cursor: "a".repeat(100) }).success).toBe(true);
  });

  it("rejects a numeric cursor", () => {
    expect(ZListSharedWithMeInputSchema.safeParse({ cursor: 5 }).success).toBe(false);
  });
});
