import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPassagesHandler } from "./listPassages.handler";
import { ZListPassagesInputSchema } from "./listPassages.schema";

const mocks = vi.hoisted(() => ({
  listPassages: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerResultsService.container", () => ({
  getNotetakerResultsService: () => ({ listPassages: mocks.listPassages }),
}));

const bookingUid = "booking-uid-1";
const user = { id: 7 } as NonNullable<TrpcSessionUser>;

const passage: NotetakerPassageDto = {
  index: 0,
  speakerName: "Host Name",
  unknownSpeakerNumber: null,
  startMs: 0,
  endMs: 1500,
  text: "Hello everyone.",
  language: "en",
};

const result = { passages: [passage], nextCursor: 5 };

const run = () =>
  listPassagesHandler({ ctx: { user }, input: ZListPassagesInputSchema.parse({ bookingUid }) });

describe("listPassagesHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPassages.mockResolvedValue(result);
  });

  it("passes input and user id to the results service", async () => {
    await run();

    expect(mocks.listPassages).toHaveBeenCalledTimes(1);
    expect(mocks.listPassages).toHaveBeenCalledWith({ bookingUid, limit: 200, userId: 7 });
  });

  it("returns passages and nextCursor unchanged", async () => {
    const output = await run();

    expect(output).toBe(result);
  });
});

describe("ZListPassagesInputSchema", () => {
  it("defaults limit to 200", () => {
    expect(ZListPassagesInputSchema.parse({ bookingUid }).limit).toBe(200);
  });

  it("rejects a limit of 0", () => {
    expect(ZListPassagesInputSchema.safeParse({ bookingUid, limit: 0 }).success).toBe(false);
  });

  it("rejects a limit of 501", () => {
    expect(ZListPassagesInputSchema.safeParse({ bookingUid, limit: 501 }).success).toBe(false);
  });

  it("accepts the limit bounds 1 and 500", () => {
    expect(ZListPassagesInputSchema.parse({ bookingUid, limit: 1 }).limit).toBe(1);
    expect(ZListPassagesInputSchema.parse({ bookingUid, limit: 500 }).limit).toBe(500);
  });

  it("parses without sessionId and cursor", () => {
    const parsed = ZListPassagesInputSchema.parse({ bookingUid });

    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it("keeps sessionId and cursor when present", () => {
    const parsed = ZListPassagesInputSchema.parse({ bookingUid, sessionId: "session-1", cursor: 12 });

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.cursor).toBe(12);
  });
});
