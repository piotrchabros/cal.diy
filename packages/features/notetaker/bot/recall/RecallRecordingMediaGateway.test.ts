import { ErrorWithCode } from "@calcom/lib/errors";
import { describe, expect, it, vi } from "vitest";
import { createRecallApiError, type IRecallApiClient } from "./RecallApiClient";
import { RecallRecordingMediaGateway } from "./RecallRecordingMediaGateway";
import type { RecallBot, RecallRecording } from "./recallSchemas";

const VIDEO_URL = "https://files.example.com/video.mp4?X-Signature=presigned-secret";

function recording(overrides: Partial<RecallRecording> = {}): RecallRecording {
  return { id: "rec-1", started_at: "2026-01-01T10:00:00Z", ...overrides };
}

function withVideo(code: string, url: string | null = VIDEO_URL): RecallRecording {
  return recording({
    media_shortcuts: {
      video_mixed: { id: "vid-1", status: { code }, data: url === null ? null : { download_url: url } },
    },
  });
}

function setup(retrieveBot: (botId: string) => Promise<RecallBot | null>) {
  const client = { retrieveBot: vi.fn(retrieveBot) } as unknown as IRecallApiClient;
  return { gateway: new RecallRecordingMediaGateway({ client }), client };
}

function botWith(...recordings: RecallRecording[]): RecallBot {
  return { id: "bot-1", status_changes: [], recordings };
}

describe("RecallRecordingMediaGateway.getVideoDownload", () => {
  it("returns the presigned url when the video is done", async () => {
    const { gateway, client } = setup(async () => botWith(withVideo("done")));

    await expect(gateway.getVideoDownload("bot-1")).resolves.toEqual({ status: "AVAILABLE", url: VIDEO_URL });
    expect(client.retrieveBot).toHaveBeenCalledWith("bot-1");
  });

  it("reports PROCESSING while the video shortcut is processing", async () => {
    const { gateway } = setup(async () => botWith(withVideo("processing", null)));

    await expect(gateway.getVideoDownload("bot-1")).resolves.toEqual({ status: "PROCESSING" });
  });

  it("reports PROCESSING when the recording is processing and has no shortcut yet", async () => {
    const { gateway } = setup(async () => botWith(recording({ status: { code: "processing" } })));

    await expect(gateway.getVideoDownload("bot-1")).resolves.toEqual({ status: "PROCESSING" });
  });

  it.each([
    ["no recordings", botWith()],
    ["no shortcut on a finished recording", botWith(recording({ status: { code: "done" } }))],
    ["a failed video", botWith(withVideo("failed", null))],
    ["a deleted video", botWith(withVideo("deleted", null))],
    ["a done video without a url", botWith(withVideo("done", null))],
    ["a non-https url", botWith(withVideo("done", "http://files.example.com/video.mp4"))],
  ])("reports UNAVAILABLE for %s", async (_name, bot) => {
    const { gateway } = setup(async () => bot);

    await expect(gateway.getVideoDownload("bot-1")).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("reports UNAVAILABLE when Recall does not know the bot", async () => {
    const { gateway } = setup(async () => null);

    await expect(gateway.getVideoDownload("bot-1")).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("uses the earliest recording when there are several", async () => {
    const early = { ...withVideo("done", "https://files.example.com/early.mp4"), id: "early" };
    early.started_at = "2026-01-01T10:00:00Z";
    const late = { ...withVideo("done", "https://files.example.com/late.mp4"), id: "late" };
    late.started_at = "2026-01-01T11:00:00Z";
    const { gateway } = setup(async () => botWith(late, early));

    await expect(gateway.getVideoDownload("bot-1")).resolves.toEqual({
      status: "AVAILABLE",
      url: "https://files.example.com/early.mp4",
    });
  });

  it("throws an ErrorWithCode naming only the error kind for Recall API errors", async () => {
    const apiError = createRecallApiError("UNAVAILABLE", `GET ${VIDEO_URL} failed`, { status: 503 });
    const { gateway } = setup(async () => {
      throw apiError;
    });

    const error = await gateway.getVideoDownload("bot-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWithCode);
    expect((error as ErrorWithCode).message).toBe("Recall video lookup failed: UNAVAILABLE (status 503)");
    expect((error as ErrorWithCode).message).not.toContain("https://");
  });

  it("rethrows errors that are not Recall API errors", async () => {
    const boom = new Error("boom");
    const { gateway } = setup(async () => {
      throw boom;
    });

    await expect(gateway.getVideoDownload("bot-1")).rejects.toBe(boom);
  });
});
