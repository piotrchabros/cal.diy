import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMeetingContactsHandler } from "./setMeetingContacts.handler";
import { ZSetMeetingContactsInputSchema } from "./setMeetingContacts.schema";

const mocks = vi.hoisted(() => ({
  setMeetingContacts: vi.fn(),
  checkRateLimitAndThrowError: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerAdHocService.container", () => ({
  getNotetakerAdHocService: () => ({ setMeetingContacts: mocks.setMeetingContacts }),
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: mocks.checkRateLimitAndThrowError,
}));

const user = { id: 7 } as NonNullable<TrpcSessionUser>;
const baseInput = { bookingUid: "uid-1", emails: ["client@example.com"] };

const run = (input: Record<string, unknown> = baseInput) =>
  setMeetingContactsHandler({ ctx: { user }, input: ZSetMeetingContactsInputSchema.parse(input) });

describe("setMeetingContactsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimitAndThrowError.mockResolvedValue(undefined);
    mocks.setMeetingContacts.mockResolvedValue({
      meetingContacts: [{ email: "client@example.com", name: null, source: "MANUAL" }],
    });
  });

  it("rate limits by user id before calling the service", async () => {
    await run();

    expect(mocks.checkRateLimitAndThrowError).toHaveBeenCalledWith({
      identifier: "notetaker.setMeetingContacts:7",
      rateLimitingType: "core",
    });
    expect(mocks.checkRateLimitAndThrowError.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setMeetingContacts.mock.invocationCallOrder[0]
    );
  });

  it("does not call the service when the rate limit throws", async () => {
    const error = new TRPCError({ code: "TOO_MANY_REQUESTS" });
    mocks.checkRateLimitAndThrowError.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(mocks.setMeetingContacts).not.toHaveBeenCalled();
  });

  it("passes the user id from ctx and the normalised emails, and returns the stored contacts", async () => {
    const result = await run({ bookingUid: "uid-1", emails: [" Client@Example.com "] });

    expect(mocks.setMeetingContacts).toHaveBeenCalledWith({
      userId: 7,
      bookingUid: "uid-1",
      emails: ["client@example.com"],
    });
    expect(result).toEqual({
      meetingContacts: [{ email: "client@example.com", name: null, source: "MANUAL" }],
    });
  });

  it("propagates service ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("MEETING_CONTACTS_NOT_SUPPORTED");
    mocks.setMeetingContacts.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
  });
});

describe("ZSetMeetingContactsInputSchema", () => {
  const parse = (overrides: Record<string, unknown>) =>
    ZSetMeetingContactsInputSchema.safeParse({ ...baseInput, ...overrides }).success;

  it("accepts an empty list to clear the contacts", () => {
    expect(parse({ emails: [] })).toBe(true);
  });

  it("rejects more than 20 emails, invalid emails and a missing booking uid", () => {
    expect(parse({ emails: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) })).toBe(false);
    expect(parse({ emails: ["nope"] })).toBe(false);
    expect(parse({ bookingUid: "" })).toBe(false);
  });
});
