/** @vitest-environment node */

import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { verifyAgentBrowserViewerToken } from "@calcom/lib/agentBrowser/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { MeetingAgentBrowserService } from "../browser/MeetingAgentBrowserService";
import { getNotetakerConfig } from "../lib/config";
import { createNotetakerAgentBrowser, moduleLoader } from "./NotetakerAgentBrowser.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const FAKE_ANTHROPIC_KEY = "test-anthropic-key-not-real";
const FAKE_RECALL_KEY = "test-recall-key-not-real";
const FAKE_RECALL_SECRET = "whsec_c2VjcmV0LWtleS1ieXRlcw==";
const FAKE_BROWSER_SECRET = "test-agent-browser-secret-not-real-0123456789";
const INTERNAL_URL = "http://127.0.0.1:4410";

const USABLE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  NOTETAKER_AGENT_ENABLED: "true",
  NOTETAKER_BOT_PROVIDER: "recall",
  RECALL_API_KEY: FAKE_RECALL_KEY,
  RECALL_WEBHOOK_VERIFICATION_SECRET: FAKE_RECALL_SECRET,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
  NOTETAKER_AGENT_BROWSER_ENABLED: "true",
  AGENT_BROWSER_INTERNAL_URL: INTERNAL_URL,
  AGENT_BROWSER_PUBLIC_URL: "https://cal.example.com/agent-browser",
  AGENT_BROWSER_SECRET: FAKE_BROWSER_SECRET,
};

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies ISimpleLogger;
}

function createFakeRecallClient() {
  return {
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
}

function create(env: NodeJS.ProcessEnv) {
  const logger = createLogger();
  const recallClient = createFakeRecallClient();
  const getRecallClient = vi.fn(() => recallClient);
  const browser = createNotetakerAgentBrowser({ config: getNotetakerConfig(env), logger, getRecallClient });
  return { browser, logger, getRecallClient, recallClient };
}

function loggedCalls(logger: ReturnType<typeof createLogger>) {
  return [
    ...logger.debug.mock.calls,
    ...logger.error.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
  ];
}

describe("createNotetakerAgentBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the browser service without logging when the browser is usable", () => {
    const { browser, logger, getRecallClient } = create(USABLE_ENV);

    expect(browser).toBeInstanceOf(MeetingAgentBrowserService);
    expect(getRecallClient).toHaveBeenCalledTimes(1);
    expect(loggedCalls(logger)).toEqual([]);
  });

  it("signs viewer tokens that outlive the longest meeting by ten minutes", async () => {
    const pageState = {
      created: true,
      url: "https://example.com/",
      title: "Example",
      snapshot: "Elements:",
      viewers: 0,
      screenshot: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(pageState), { status: 200 }))
    );
    const { browser, recallClient } = create({ ...USABLE_ENV, NOTETAKER_MAX_DURATION_SECONDS: "3600" });

    await browser?.forBot("bot_1").open("https://example.com");

    const [, viewerUrl] = recallClient.startScreenshare.mock.calls[0];
    const token = new URL(viewerUrl).searchParams.get("token") ?? "";
    const verified = verifyAgentBrowserViewerToken({ secret: FAKE_BROWSER_SECRET, token, now: new Date() });
    expect(verified?.botId).toBe("bot_1");
    expect(((verified?.expiresAt.getTime() ?? 0) - (verified?.issuedAt.getTime() ?? 0)) / 1000).toBe(4200);
  });

  it("returns null without warning or touching the Recall client when the browser is disabled", () => {
    const { browser, logger, getRecallClient } = create({
      ...USABLE_ENV,
      NOTETAKER_AGENT_BROWSER_ENABLED: undefined,
    });

    expect(browser).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(getRecallClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the meeting agent is not usable",
      env: { ...USABLE_ENV, ANTHROPIC_API_KEY: undefined },
      expected: { agentUsable: false, hasInternalUrl: true, hasPublicUrl: true, hasSecret: true },
    },
    {
      name: "the internal URL is missing",
      env: { ...USABLE_ENV, AGENT_BROWSER_INTERNAL_URL: undefined },
      expected: { agentUsable: true, hasInternalUrl: false, hasPublicUrl: true, hasSecret: true },
    },
    {
      name: "the public URL is not https",
      env: { ...USABLE_ENV, AGENT_BROWSER_PUBLIC_URL: "http://cal.example.com/agent-browser" },
      expected: { agentUsable: true, hasInternalUrl: true, hasPublicUrl: false, hasSecret: true },
    },
    {
      name: "the secret is too short",
      env: { ...USABLE_ENV, AGENT_BROWSER_SECRET: "short" },
      expected: { agentUsable: true, hasInternalUrl: true, hasPublicUrl: true, hasSecret: false },
    },
  ])("returns null and warns once with booleans only when $name", ({ env, expected }) => {
    const { browser, logger, getRecallClient } = create(env);

    expect(browser).toBeNull();
    expect(getRecallClient).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Notetaker agent browser is enabled but not usable", expected);

    const serialized = JSON.stringify(loggedCalls(logger));
    expect(serialized).not.toContain(FAKE_BROWSER_SECRET);
    expect(serialized).not.toContain(INTERNAL_URL);
    expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(serialized).not.toContain(FAKE_RECALL_KEY);
  });
});

describe("moduleLoader", () => {
  it("binds the agent browser token", () => {
    expect(moduleLoader.token).toBe(NOTETAKER_DI_TOKENS.NOTETAKER_AGENT_BROWSER);
  });
});
