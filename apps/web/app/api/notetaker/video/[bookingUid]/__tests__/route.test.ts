import type { NotetakerVideoDownloadResult } from "@calcom/features/notetaker/bot/INotetakerRecordingMediaGateway";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

const harness = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<{ user: { id: number } } | null>>(),
  getVideoDownload:
    vi.fn<(params: { bookingUid: string; userId: number }) => Promise<NotetakerVideoDownloadResult>>(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: harness.getSession,
}));

// Mocking the container keeps the Prisma repositories and the real Recall client from loading.
vi.mock("@calcom/features/notetaker/di/NotetakerResultsService.container", () => ({
  getNotetakerResultsService: () => ({ getVideoDownload: harness.getVideoDownload }),
}));

vi.mock("@lib/buildLegacyCtx", () => ({
  buildLegacyRequest: vi.fn(() => ({})),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ getAll: () => [] })),
}));

vi.mock("@calcom/lib/logger", () => ({
  // The root logger is also used by the perf observer that defaultResponderForAppDir triggers.
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getSubLogger: () => harness.log },
}));

const BOOKING_UID = "booking-uid-1";
const USER_ID = 42;
const VIDEO_URL = "https://recall.example.com/video.mp4?X-Amz-Signature=abc";

async function callRoute(bookingUid: string = BOOKING_UID): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/notetaker/video/${bookingUid}`);
  return GET(request, { params: Promise.resolve({ bookingUid }) });
}

function expectPrivateHeaders(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
}

describe("GET /api/notetaker/video/[bookingUid]", () => {
  beforeEach(() => {
    harness.getSession.mockResolvedValue({ user: { id: USER_ID } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when nobody is signed in and asks the service nothing", async () => {
    harness.getSession.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Unauthorized" });
    expectPrivateHeaders(response);
    expect(harness.getVideoDownload).not.toHaveBeenCalled();
  });

  it("redirects to the video URL for a reader", async () => {
    harness.getVideoDownload.mockResolvedValue({ status: "AVAILABLE", url: VIDEO_URL });

    const response = await callRoute();

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(VIDEO_URL);
    expectPrivateHeaders(response);
    expect(harness.getVideoDownload).toHaveBeenCalledWith({ bookingUid: BOOKING_UID, userId: USER_ID });
  });

  it.each([
    ["NotFound", ErrorWithCode.Factory.NotFound("Booking booking-uid-1 has no notetaker transcript")],
    ["Forbidden", ErrorWithCode.Factory.Forbidden("You do not have access to these notes")],
  ])("answers %s with the same 404", async (_name, error) => {
    harness.getVideoDownload.mockRejectedValue(error);

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Video not found" });
    expectPrivateHeaders(response);
  });

  it("returns the same 404 when no video is available", async () => {
    harness.getVideoDownload.mockResolvedValue({ status: "UNAVAILABLE" });

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Video not found" });
    expectPrivateHeaders(response);
  });

  it("returns 409 while the video is processing", async () => {
    harness.getVideoDownload.mockResolvedValue({ status: "PROCESSING" });

    const response = await callRoute();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "The video is still being processed" });
    expectPrivateHeaders(response);
  });

  it("returns 502 for a provider failure and logs only the error kind", async () => {
    harness.getVideoDownload.mockRejectedValue(
      ErrorWithCode.Factory.InternalServerError("Recall video lookup failed: network SECRETDETAIL")
    );

    const response = await callRoute();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: "The video could not be fetched" });
    expectPrivateHeaders(response);
    expect(harness.log.error).toHaveBeenCalledWith("Notetaker video lookup failed", {
      kind: ErrorCode.InternalServerError,
    });
    expect(JSON.stringify(harness.log.error.mock.calls)).not.toContain("SECRETDETAIL");
  });

  it("returns 502 for an unexpected error", async () => {
    harness.getVideoDownload.mockRejectedValue(new TypeError("boom SECRETDETAIL"));

    const response = await callRoute();

    expect(response.status).toBe(502);
    expectPrivateHeaders(response);
    expect(harness.log.error).toHaveBeenCalledWith("Notetaker video lookup failed", { kind: "TypeError" });
  });

  it("returns 404 for a booking uid that is too long", async () => {
    const response = await callRoute("x".repeat(129));

    expect(response.status).toBe(404);
    expectPrivateHeaders(response);
    expect(harness.getVideoDownload).not.toHaveBeenCalled();
  });
});
