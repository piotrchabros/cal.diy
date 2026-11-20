/** @vitest-environment node */

import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { describe, expect, it, vi } from "vitest";
import { ClaudeMeetingAgent } from "../agent/ClaudeMeetingAgent";
import { getNotetakerConfig } from "../lib/config";
import { createNotetakerMeetingAgent, moduleLoader } from "./NotetakerMeetingAgent.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const FAKE_ANTHROPIC_KEY = "test-anthropic-key-not-real";
const FAKE_RECALL_KEY = "test-recall-key-not-real";
const FAKE_RECALL_SECRET = "whsec_c2VjcmV0LWtleS1ieXRlcw==";

const USABLE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  NOTETAKER_AGENT_ENABLED: "true",
  NOTETAKER_BOT_PROVIDER: "recall",
  RECALL_API_KEY: FAKE_RECALL_KEY,
  RECALL_WEBHOOK_VERIFICATION_SECRET: FAKE_RECALL_SECRET,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
};

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } satisfies ISimpleLogger;
}

function create(env: NodeJS.ProcessEnv) {
  const logger = createLogger();
  const agent = createNotetakerMeetingAgent({ config: getNotetakerConfig(env), logger });
  return { agent, logger };
}

function loggedCalls(logger: ReturnType<typeof createLogger>) {
  return [
    ...logger.debug.mock.calls,
    ...logger.error.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
  ];
}

describe("createNotetakerMeetingAgent", () => {
  it("returns the Claude agent without logging when the agent is usable", () => {
    const { agent, logger } = create(USABLE_ENV);

    expect(agent).toBeInstanceOf(ClaudeMeetingAgent);
    expect(loggedCalls(logger)).toEqual([]);
  });

  it("returns null without warning when the agent is disabled", () => {
    const { agent, logger } = create({ ...USABLE_ENV, NOTETAKER_AGENT_ENABLED: undefined });

    expect(agent).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the Anthropic key is missing",
      env: { ...USABLE_ENV, ANTHROPIC_API_KEY: undefined },
      expected: { botProviderIsRecall: true, hasRecallConfig: true, hasAnthropicApiKey: false },
    },
    {
      name: "the bot provider is not recall",
      env: { ...USABLE_ENV, NOTETAKER_BOT_PROVIDER: "fake" },
      expected: { botProviderIsRecall: false, hasRecallConfig: true, hasAnthropicApiKey: true },
    },
    {
      name: "the Recall config is missing",
      env: { ...USABLE_ENV, RECALL_API_KEY: undefined, RECALL_WEBHOOK_VERIFICATION_SECRET: undefined },
      expected: { botProviderIsRecall: true, hasRecallConfig: false, hasAnthropicApiKey: true },
    },
  ])("returns null and warns once with booleans only when $name", ({ env, expected }) => {
    const { agent, logger } = create(env);

    expect(agent).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Notetaker meeting agent is enabled but not usable", expected);

    const serialized = JSON.stringify(loggedCalls(logger));
    expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(serialized).not.toContain(FAKE_RECALL_KEY);
    expect(serialized).not.toContain(FAKE_RECALL_SECRET);
  });
});

describe("moduleLoader", () => {
  it("binds the meeting agent token", () => {
    expect(moduleLoader.token).toBe(NOTETAKER_DI_TOKENS.NOTETAKER_MEETING_AGENT);
  });
});
