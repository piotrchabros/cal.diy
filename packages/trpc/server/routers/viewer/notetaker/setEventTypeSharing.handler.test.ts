import type { NotetakerEventTypeSharingDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEventTypeSharingHandler } from "./setEventTypeSharing.handler";
import { ZSetEventTypeSharingInputSchema } from "./setEventTypeSharing.schema";

const mocks = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerSharingSettingsService.container", () => ({
  getNotetakerSharingSettingsService: () => ({ set: mocks.set }),
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const dto: NotetakerEventTypeSharingDto = {
  eventTypeId: 42,
  available: true,
  unavailableReason: null,
  mode: "SELECTED_PEOPLE",
  teamName: "Sales",
  people: [],
  setAt: null,
  setByName: null,
};
const run = (input: unknown) =>
  setEventTypeSharingHandler({ ctx: { user }, input: ZSetEventTypeSharingInputSchema.parse(input) });

describe("setEventTypeSharingHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.set.mockResolvedValue(dto);
  });

  it("passes the mode and user ids with the user id taken from ctx", async () => {
    await run({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [3, 4] });

    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith({
      eventTypeId: 42,
      mode: "SELECTED_PEOPLE",
      userIds: [3, 4],
      userId: 7,
    });
  });

  it("leaves userIds undefined when the input has none", async () => {
    await run({ eventTypeId: 42, mode: "TEAM" });

    expect(mocks.set.mock.calls[0]?.[0].userIds).toBeUndefined();
  });

  it("returns the DTO from the service unchanged", async () => {
    expect(await run({ eventTypeId: 42, mode: "TEAM" })).toBe(dto);
  });

  it("propagates an ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("PERSON_NOT_ELIGIBLE");
    mocks.set.mockRejectedValue(error);

    await expect(run({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [3] })).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZSetEventTypeSharingInputSchema", () => {
  const parse = (input: unknown) => ZSetEventTypeSharingInputSchema.safeParse(input).success;

  it("accepts each mode", () => {
    for (const mode of ["HOSTS_ONLY", "TEAM", "SELECTED_PEOPLE"]) {
      expect(parse({ eventTypeId: 42, mode })).toBe(true);
    }
  });

  it("rejects an unknown mode", () => {
    expect(parse({ eventTypeId: 42, mode: "EVERYONE" })).toBe(false);
  });

  it("accepts 50 distinct ids and rejects 51", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

    expect(parse({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: ids(50) })).toBe(true);
    expect(parse({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: ids(51) })).toBe(false);
  });

  it("rejects duplicate ids", () => {
    expect(parse({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [3, 3] })).toBe(false);
  });

  it("rejects non-positive and non-integer ids", () => {
    expect(parse({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [0] })).toBe(false);
    expect(parse({ eventTypeId: 42, mode: "SELECTED_PEOPLE", userIds: [1.5] })).toBe(false);
  });

  it("rejects a missing eventTypeId or mode", () => {
    expect(parse({ mode: "TEAM" })).toBe(false);
    expect(parse({ eventTypeId: 42 })).toBe(false);
  });
});
