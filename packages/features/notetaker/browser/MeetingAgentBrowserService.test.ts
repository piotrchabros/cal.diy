import type { AgentBrowserPageState } from "@calcom/lib/agentBrowser/contract";
import { describe, expect, it, vi } from "vitest";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { createRecallApiError } from "../bot/recall/RecallApiClient";
import { createAgentBrowserGatewayError, type IAgentBrowserGateway } from "./IAgentBrowserGateway";
import { MeetingAgentBrowserService } from "./MeetingAgentBrowserService";

const BOT_ID = "bot_1";
const VIEWER_URL = "https://cal.example.com/agent-browser/view?token=t";

function pageState(overrides: Partial<AgentBrowserPageState> = {}): AgentBrowserPageState {
  return {
    created: true,
    url: "https://example.com/",
    title: "Example",
    snapshot: "Elements:",
    viewers: 0,
    screenshot: null,
    ...overrides,
  };
}

function setup(options: { shareGraceMs?: number } = {}) {
  let nowMs = Date.parse("2026-11-20T10:00:00.000Z");
  const gateway = {
    perform: vi.fn<IAgentBrowserGateway["perform"]>().mockResolvedValue(pageState()),
    closeSession: vi.fn<IAgentBrowserGateway["closeSession"]>().mockResolvedValue(undefined),
    buildViewerUrl: vi.fn<IAgentBrowserGateway["buildViewerUrl"]>().mockReturnValue(VIEWER_URL),
  } satisfies IAgentBrowserGateway;
  const recallClient = {
    createBot: vi.fn<IRecallApiClient["createBot"]>(),
    retrieveBot: vi.fn<IRecallApiClient["retrieveBot"]>(),
    listBotsByMetadata: vi.fn<IRecallApiClient["listBotsByMetadata"]>(),
    leaveCall: vi.fn<IRecallApiClient["leaveCall"]>(),
    deleteScheduledBot: vi.fn<IRecallApiClient["deleteScheduledBot"]>(),
    sendChatMessage: vi.fn<IRecallApiClient["sendChatMessage"]>(),
    outputAudio: vi.fn<IRecallApiClient["outputAudio"]>(),
    startScreenshare: vi.fn<IRecallApiClient["startScreenshare"]>().mockResolvedValue(undefined),
    stopScreenshare: vi.fn<IRecallApiClient["stopScreenshare"]>().mockResolvedValue("OK"),
    createTranscript: vi.fn<IRecallApiClient["createTranscript"]>(),
    retrieveTranscript: vi.fn<IRecallApiClient["retrieveTranscript"]>(),
    downloadTranscript: vi.fn<IRecallApiClient["downloadTranscript"]>(),
    listTranscriptsByRecording: vi.fn<IRecallApiClient["listTranscriptsByRecording"]>(),
  } satisfies IRecallApiClient;
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const service = new MeetingAgentBrowserService(
    { gateway, recallClient, logger },
    { now: () => new Date(nowMs), shareGraceMs: options.shareGraceMs }
  );
  return {
    service,
    gateway,
    recallClient,
    logger,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("MeetingAgentBrowserService.open", () => {
  it("navigates, shares the viewer when nobody watches it and returns the page", async () => {
    const { service, gateway, recallClient } = setup();

    const page = await service.forBot(BOT_ID).open("https://example.com");

    expect(gateway.perform).toHaveBeenCalledWith(BOT_ID, { type: "goto", url: "https://example.com" });
    expect(gateway.buildViewerUrl).toHaveBeenCalledWith(BOT_ID, new Date("2026-11-20T10:00:00.000Z"));
    expect(recallClient.startScreenshare).toHaveBeenCalledWith(BOT_ID, VIEWER_URL);
    expect(page).toEqual({
      url: "https://example.com/",
      title: "Example",
      snapshot: "Elements:",
      screenshot: null,
    });
  });

  it("does not share when the viewer is already connected", async () => {
    const { service, gateway, recallClient } = setup();
    gateway.perform.mockResolvedValue(pageState({ viewers: 1, created: false }));

    await service.forBot(BOT_ID).open("https://example.com");

    expect(recallClient.startScreenshare).not.toHaveBeenCalled();
  });

  it("does not share again within the grace window", async () => {
    const { service, recallClient, advance } = setup({ shareGraceMs: 20_000 });
    const browser = service.forBot(BOT_ID);

    await browser.open("https://example.com");
    advance(19_999);
    await browser.open("https://example.org");

    expect(recallClient.startScreenshare).toHaveBeenCalledTimes(1);
  });

  it("shares again after the grace window when nobody is watching", async () => {
    const { service, recallClient, advance } = setup({ shareGraceMs: 20_000 });
    const browser = service.forBot(BOT_ID);

    await browser.open("https://example.com");
    advance(20_000);
    await browser.open("https://example.org");

    expect(recallClient.startScreenshare).toHaveBeenCalledTimes(2);
  });

  it("tracks the grace window per bot", async () => {
    const { service, recallClient } = setup();

    await service.forBot(BOT_ID).open("https://example.com");
    await service.forBot("bot_2").open("https://example.com");

    expect(recallClient.startScreenshare).toHaveBeenCalledTimes(2);
  });

  it("lets a later open retry the share after it failed", async () => {
    const { service, recallClient } = setup();
    recallClient.startScreenshare.mockRejectedValueOnce(
      createRecallApiError("HTTP", "boom", { status: 500 })
    );
    const browser = service.forBot(BOT_ID);

    await expect(browser.open("https://example.com")).rejects.toThrow("boom");
    await browser.open("https://example.com");

    expect(recallClient.startScreenshare).toHaveBeenCalledTimes(2);
  });

  it("propagates gateway errors without sharing", async () => {
    const { service, gateway, recallClient } = setup();
    gateway.perform.mockRejectedValue(createAgentBrowserGatewayError("BLOCKED_URL", "blocked"));

    await expect(service.forBot(BOT_ID).open("file:///etc/passwd")).rejects.toThrow("blocked");
    expect(recallClient.startScreenshare).not.toHaveBeenCalled();
  });
});

describe("MeetingAgentBrowserService.perform", () => {
  it("passes the command through and never shares", async () => {
    const { service, gateway, recallClient } = setup();
    gateway.perform.mockResolvedValue(
      pageState({ created: false, screenshot: { mediaType: "image/jpeg", base64: "abc" } })
    );

    const page = await service.forBot(BOT_ID).perform({ type: "screenshot" });

    expect(gateway.perform).toHaveBeenCalledWith(BOT_ID, { type: "screenshot" });
    expect(page.screenshot).toEqual({ mediaType: "image/jpeg", base64: "abc" });
    expect(recallClient.startScreenshare).not.toHaveBeenCalled();
  });
});

describe("MeetingAgentBrowserService.close", () => {
  it("stops the screenshare before closing the session", async () => {
    const { service, gateway, recallClient } = setup();
    const order: string[] = [];
    recallClient.stopScreenshare.mockImplementation(async () => {
      order.push("stop");
      return "OK";
    });
    gateway.closeSession.mockImplementation(async () => {
      order.push("delete");
    });

    await service.forBot(BOT_ID).close();

    expect(order).toEqual(["stop", "delete"]);
    expect(recallClient.stopScreenshare).toHaveBeenCalledWith(BOT_ID);
    expect(gateway.closeSession).toHaveBeenCalledWith(BOT_ID);
  });

  it("tolerates a screenshare that is not active", async () => {
    const { service, gateway, recallClient } = setup();
    recallClient.stopScreenshare.mockResolvedValue("NOT_ACTIVE");

    await expect(service.forBot(BOT_ID).close()).resolves.toBeUndefined();
    expect(gateway.closeSession).toHaveBeenCalledWith(BOT_ID);
  });

  it("still closes the session when stopping the screenshare fails", async () => {
    const { service, gateway, recallClient, logger } = setup();
    recallClient.stopScreenshare.mockRejectedValue(createRecallApiError("NETWORK", "down"));

    await expect(service.forBot(BOT_ID).close()).resolves.toBeUndefined();
    expect(gateway.closeSession).toHaveBeenCalledWith(BOT_ID);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { botId: BOT_ID, kind: "NETWORK" });
  });

  it("does not throw when agent-browser is unavailable", async () => {
    const { service, gateway, logger } = setup();
    gateway.closeSession.mockRejectedValue(createAgentBrowserGatewayError("UNAVAILABLE", "down"));

    await expect(service.forBot(BOT_ID).close()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { botId: BOT_ID, kind: "UNAVAILABLE" });
  });

  it("surfaces other session close errors", async () => {
    const { service, gateway } = setup();
    gateway.closeSession.mockRejectedValue(createAgentBrowserGatewayError("UNAUTHORIZED", "bad secret"));

    await expect(service.forBot(BOT_ID).close()).rejects.toThrow("bad secret");
  });

  it("forgets the share so the next open shares again inside the grace window", async () => {
    const { service, recallClient } = setup();
    const browser = service.forBot(BOT_ID);

    await browser.open("https://example.com");
    await browser.close();
    await browser.open("https://example.com");

    expect(recallClient.startScreenshare).toHaveBeenCalledTimes(2);
  });
});

describe("MeetingAgentBrowserService.closeForBot", () => {
  it("never throws and logs only the error kind", async () => {
    const { service, gateway, logger } = setup();
    gateway.closeSession.mockRejectedValue(createAgentBrowserGatewayError("INTERNAL", "secret detail"));

    await expect(service.closeForBot(BOT_ID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { botId: BOT_ID, kind: "INTERNAL" });
  });

  it("never throws on unexpected errors", async () => {
    const { service, gateway, logger } = setup();
    gateway.closeSession.mockRejectedValue(new Error("unexpected"));

    await expect(service.closeForBot(BOT_ID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { botId: BOT_ID, kind: "UNKNOWN" });
  });
});
