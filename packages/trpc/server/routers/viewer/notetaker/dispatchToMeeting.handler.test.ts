import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchToMeetingHandler } from "./dispatchToMeeting.handler";
import { ZDispatchToMeetingInputSchema } from "./dispatchToMeeting.schema";

const mocks = vi.hoisted(() => ({
  dispatchToMeeting: vi.fn(),
  checkRateLimitAndThrowError: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerAdHocService.container", () => ({
  getNotetakerAdHocService: () => ({ dispatchToMeeting: mocks.dispatchToMeeting }),
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: mocks.checkRateLimitAndThrowError,
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const meetingUrl = "https://meet.google.com/abc-defg-hij";
const baseInput = { meetingUrl, sharingTeamId: null, acknowledgedNotice: true };

const run = (input: Record<string, unknown> = baseInput) =>
  dispatchToMeetingHandler({ ctx: { user }, input: ZDispatchToMeetingInputSchema.parse(input) });

describe("dispatchToMeetingHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimitAndThrowError.mockResolvedValue(undefined);
    mocks.dispatchToMeeting.mockResolvedValue({ bookingUid: "uid-1", reused: false });
  });

  it("rate limits by user id before calling the service", async () => {
    await run();

    expect(mocks.checkRateLimitAndThrowError).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimitAndThrowError).toHaveBeenCalledWith({
      identifier: "notetaker.dispatchToMeeting:7",
      rateLimitingType: "core",
    });
    expect(mocks.checkRateLimitAndThrowError.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchToMeeting.mock.invocationCallOrder[0]
    );
  });

  it("does not call the service when the rate limit throws", async () => {
    const error = new TRPCError({ code: "TOO_MANY_REQUESTS" });
    mocks.checkRateLimitAndThrowError.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(mocks.dispatchToMeeting).not.toHaveBeenCalled();
  });

  it("maps the input and the user id taken from ctx without the acknowledgement", async () => {
    await run({ ...baseInput, title: "Standup", durationMinutes: 90, sharingTeamId: 5 });

    expect(mocks.dispatchToMeeting).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchToMeeting).toHaveBeenCalledWith({
      userId: 7,
      meetingUrl,
      title: "Standup",
      durationMinutes: 90,
      sharingTeamId: 5,
    });
  });

  it("passes optional fields as undefined when omitted", async () => {
    await run();

    expect(mocks.dispatchToMeeting).toHaveBeenCalledWith({
      userId: 7,
      meetingUrl,
      title: undefined,
      durationMinutes: undefined,
      sharingTeamId: null,
    });
  });

  it("returns only bookingUid and reused", async () => {
    mocks.dispatchToMeeting.mockResolvedValue({ bookingUid: "uid-2", reused: true, extra: 1 });

    expect(await run()).toEqual({ bookingUid: "uid-2", reused: true });
  });

  it("propagates service ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("AD_HOC_LIMIT_REACHED");
    mocks.dispatchToMeeting.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZDispatchToMeetingInputSchema", () => {
  const parse = (overrides: Record<string, unknown>) =>
    ZDispatchToMeetingInputSchema.safeParse({ ...baseInput, ...overrides }).success;

  it("accepts the minimal input", () => {
    expect(parse({})).toBe(true);
  });

  it("rejects acknowledgedNotice false", () => {
    expect(parse({ acknowledgedNotice: false })).toBe(false);
  });

  it("rejects a missing acknowledgedNotice", () => {
    expect(ZDispatchToMeetingInputSchema.safeParse({ meetingUrl, sharingTeamId: null }).success).toBe(false);
  });

  it("rejects an empty or whitespace-only meetingUrl", () => {
    expect(parse({ meetingUrl: "" })).toBe(false);
    expect(parse({ meetingUrl: "   " })).toBe(false);
  });

  it("rejects a meetingUrl over 2048 characters", () => {
    expect(parse({ meetingUrl: "a".repeat(2049) })).toBe(false);
  });

  it("rejects durations outside 15 to 240 and non-integers", () => {
    expect(parse({ durationMinutes: 14 })).toBe(false);
    expect(parse({ durationMinutes: 241 })).toBe(false);
    expect(parse({ durationMinutes: 30.5 })).toBe(false);
  });

  it("accepts the duration bounds", () => {
    expect(parse({ durationMinutes: 15 })).toBe(true);
    expect(parse({ durationMinutes: 240 })).toBe(true);
  });

  it("rejects an empty title and a title over 200 characters", () => {
    expect(parse({ title: "" })).toBe(false);
    expect(parse({ title: "a".repeat(201) })).toBe(false);
  });

  it("requires sharingTeamId to be null or a positive integer", () => {
    expect(parse({ sharingTeamId: 0 })).toBe(false);
    expect(parse({ sharingTeamId: -1 })).toBe(false);
    expect(parse({ sharingTeamId: 1.5 })).toBe(false);
    expect(parse({ sharingTeamId: 3 })).toBe(true);
    expect(ZDispatchToMeetingInputSchema.safeParse({ meetingUrl, acknowledgedNotice: true }).success).toBe(
      false
    );
  });
});
