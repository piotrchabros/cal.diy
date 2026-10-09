import type { NotetakerExportDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportHandler } from "./export.handler";
import { ZExportInputSchema } from "./export.schema";

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerResultsService.container", () => ({
  getNotetakerResultsService: () => ({ export: mocks.export }),
}));

const bookingUid = "booking-uid-1";
const user = { id: 7 } as NonNullable<TrpcSessionUser>;

const exported: NotetakerExportDto = {
  filename: "meeting-2026-01-01.md",
  mimeType: "text/markdown",
  content: "# Meeting",
};

const run = () =>
  exportHandler({ ctx: { user }, input: ZExportInputSchema.parse({ bookingUid, format: "markdown" }) });

describe("exportHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.export.mockResolvedValue(exported);
  });

  it("calls the service once with the booking uid, the format and the user id taken from ctx", async () => {
    await run();

    expect(mocks.export).toHaveBeenCalledTimes(1);
    expect(mocks.export).toHaveBeenCalledWith({ bookingUid, format: "markdown", userId: 7 });
  });

  it("returns the service result unchanged", async () => {
    const result = await run();

    expect(result).toBe(exported);
  });

  it("propagates a Forbidden ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.Forbidden("forbidden");
    mocks.export.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a NotFound ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.NotFound("not found");
    mocks.export.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it("propagates a BadRequest ErrorWithCode unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("bad request");
    mocks.export.mockRejectedValue(error);

    await expect(run()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });
});

describe("ZExportInputSchema", () => {
  it("rejects a missing bookingUid", () => {
    expect(ZExportInputSchema.safeParse({ format: "markdown" }).success).toBe(false);
  });

  it("rejects a format other than markdown", () => {
    expect(ZExportInputSchema.safeParse({ bookingUid, format: "pdf" }).success).toBe(false);
  });

  it("rejects a missing format", () => {
    expect(ZExportInputSchema.safeParse({ bookingUid }).success).toBe(false);
  });

  it("accepts a bookingUid with the markdown format", () => {
    expect(ZExportInputSchema.safeParse({ bookingUid, format: "markdown" }).success).toBe(true);
  });

  it("carries no user, session or file name field", () => {
    const parsed = ZExportInputSchema.parse({
      bookingUid,
      format: "markdown",
      userId: 99,
      sessionId: "s",
      filename: "x.md",
    });

    expect(parsed).toEqual({ bookingUid, format: "markdown" });
  });
});
