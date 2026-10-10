import type { NotetakerSharingCandidatesDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listEventTypeSharingCandidatesHandler } from "./listEventTypeSharingCandidates.handler";
import { ZListEventTypeSharingCandidatesInputSchema } from "./listEventTypeSharingCandidates.schema";

const mocks = vi.hoisted(() => ({ listCandidates: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerSharingSettingsService.container", () => ({
  getNotetakerSharingSettingsService: () => ({ listCandidates: mocks.listCandidates }),
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerSharingCandidatesDto = {
  items: [{ userId: 3, name: "Sam", email: "sam@example.com", avatarUrl: null }],
  nextCursor: null,
};
const run = (input: unknown) =>
  listEventTypeSharingCandidatesHandler({
    ctx: { user },
    input: ZListEventTypeSharingCandidatesInputSchema.parse(input),
  });

describe("listEventTypeSharingCandidatesHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCandidates.mockResolvedValue(dto);
  });

  it("passes search, cursor and limit with the user id taken from ctx", async () => {
    await run({ eventTypeId: 42, search: "sa", cursor: 9, limit: 10 });

    expect(mocks.listCandidates).toHaveBeenCalledTimes(1);
    expect(mocks.listCandidates).toHaveBeenCalledWith({
      eventTypeId: 42,
      search: "sa",
      cursor: 9,
      limit: 10,
      userId: 7,
    });
  });

  it("uses the default limit of 20", async () => {
    await run({ eventTypeId: 42 });

    expect(mocks.listCandidates.mock.calls[0]?.[0].limit).toBe(20);
  });

  it("returns the DTO from the service unchanged", async () => {
    expect(await run({ eventTypeId: 42 })).toBe(dto);
  });

  it("propagates an ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("NOT_A_TEAM_EVENT_TYPE");
    mocks.listCandidates.mockRejectedValue(error);

    await expect(run({ eventTypeId: 42 })).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZListEventTypeSharingCandidatesInputSchema", () => {
  const parse = (input: unknown) => ZListEventTypeSharingCandidatesInputSchema.safeParse(input);

  it("accepts limits 1 and 50 and rejects 0 and 51", () => {
    expect(parse({ eventTypeId: 42, limit: 1 }).success).toBe(true);
    expect(parse({ eventTypeId: 42, limit: 50 }).success).toBe(true);
    expect(parse({ eventTypeId: 42, limit: 0 }).success).toBe(false);
    expect(parse({ eventTypeId: 42, limit: 51 }).success).toBe(false);
  });

  it("trims the search and rejects one over 100 characters", () => {
    expect(parse({ eventTypeId: 42, search: "  sam " })).toMatchObject({
      success: true,
      data: { search: "sam" },
    });
    expect(parse({ eventTypeId: 42, search: "a".repeat(101) }).success).toBe(false);
  });

  it("rejects a non-integer cursor", () => {
    expect(parse({ eventTypeId: 42, cursor: 1.5 }).success).toBe(false);
    expect(parse({ eventTypeId: 42, cursor: "9" }).success).toBe(false);
  });

  it("rejects a missing eventTypeId", () => {
    expect(parse({}).success).toBe(false);
  });
});
