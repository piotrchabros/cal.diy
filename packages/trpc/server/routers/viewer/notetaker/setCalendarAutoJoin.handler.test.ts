import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCalendarAutoJoinHandler } from "./setCalendarAutoJoin.handler";
import { ZSetCalendarAutoJoinInputSchema } from "./setCalendarAutoJoin.schema";

const mocks = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("@calcom/features/notetaker/di/NotetakerCalendarAutoJoinSettingsService.container", () => ({
  getNotetakerCalendarAutoJoinSettingsService: () => ({ set: mocks.set }),
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const run = (input: unknown) =>
  setCalendarAutoJoinHandler({ ctx: { user }, input: ZSetCalendarAutoJoinInputSchema.parse(input) });

describe("setCalendarAutoJoinHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.set.mockResolvedValue(undefined);
  });

  it("passes the input with the user id taken from ctx", async () => {
    await run({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: 3 });

    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith({
      userId: 7,
      selectedCalendarId: "sc-1",
      enabled: true,
      sharingTeamId: 3,
    });
  });

  it("passes a null sharing team through", async () => {
    await run({ selectedCalendarId: "sc-1", enabled: false, sharingTeamId: null });

    expect(mocks.set.mock.calls[0]?.[0].sharingTeamId).toBeNull();
  });

  it("propagates an ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("Selected calendar not found");
    mocks.set.mockRejectedValue(error);

    await expect(run({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: null })).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZSetCalendarAutoJoinInputSchema", () => {
  const parse = (input: unknown) => ZSetCalendarAutoJoinInputSchema.safeParse(input).success;

  it("accepts a positive integer or null sharing team", () => {
    expect(parse({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: 3 })).toBe(true);
    expect(parse({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: null })).toBe(true);
  });

  it("rejects a missing, non-positive or non-integer sharing team", () => {
    expect(parse({ selectedCalendarId: "sc-1", enabled: true })).toBe(false);
    expect(parse({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: 0 })).toBe(false);
    expect(parse({ selectedCalendarId: "sc-1", enabled: true, sharingTeamId: 1.5 })).toBe(false);
  });

  it("rejects an empty calendar id or a missing enabled flag", () => {
    expect(parse({ selectedCalendarId: "", enabled: true, sharingTeamId: null })).toBe(false);
    expect(parse({ selectedCalendarId: "sc-1", sharingTeamId: null })).toBe(false);
  });
});
