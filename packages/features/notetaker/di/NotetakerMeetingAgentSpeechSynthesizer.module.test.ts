/** @vitest-environment node */

import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { describe, expect, it, vi } from "vitest";
import { ElevenLabsSpeechSynthesizer } from "../agent/tts/ElevenLabsSpeechSynthesizer";
import { getNotetakerConfig } from "../lib/config";
import {
  createNotetakerMeetingAgentSpeechSynthesizer,
  moduleLoader,
} from "./NotetakerMeetingAgentSpeechSynthesizer.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const FAKE_ANTHROPIC_KEY = "test-anthropic-key-not-real";
const FAKE_RECALL_KEY = "test-recall-key-not-real";
const FAKE_RECALL_SECRET = "whsec_c2VjcmV0LWtleS1ieXRlcw==";
const FAKE_ELEVENLABS_KEY = "test-elevenlabs-key-not-real";

const USABLE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  NOTETAKER_AGENT_ENABLED: "true",
  NOTETAKER_BOT_PROVIDER: "recall",
  NOTETAKER_AGENT_SPEECH_PROVIDER: "deepgram",
  RECALL_API_KEY: FAKE_RECALL_KEY,
  RECALL_WEBHOOK_VERIFICATION_SECRET: FAKE_RECALL_SECRET,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
  ELEVENLABS_API_KEY: FAKE_ELEVENLABS_KEY,
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
  const synthesizer = createNotetakerMeetingAgentSpeechSynthesizer({
    config: getNotetakerConfig(env),
    logger,
  });
  return { synthesizer, logger };
}

function loggedCalls(logger: ReturnType<typeof createLogger>) {
  return [
    ...logger.debug.mock.calls,
    ...logger.error.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
  ];
}

describe("createNotetakerMeetingAgentSpeechSynthesizer", () => {
  it("returns the ElevenLabs synthesizer without logging when voice is usable", () => {
    const { synthesizer, logger } = create(USABLE_ENV);

    expect(synthesizer).toBeInstanceOf(ElevenLabsSpeechSynthesizer);
    expect(loggedCalls(logger)).toEqual([]);
  });

  it("returns null without warning when the ElevenLabs key is missing", () => {
    const { synthesizer, logger } = create({ ...USABLE_ENV, ELEVENLABS_API_KEY: undefined });

    expect(synthesizer).toBeNull();
    expect(loggedCalls(logger)).toEqual([]);
  });

  it.each([
    {
      name: "the agent is disabled",
      env: { ...USABLE_ENV, NOTETAKER_AGENT_ENABLED: undefined },
      expected: { agentUsable: false, speechProviderIsNone: false, voiceEnabled: true },
    },
    {
      name: "the speech provider is none",
      env: { ...USABLE_ENV, NOTETAKER_AGENT_SPEECH_PROVIDER: undefined },
      expected: { agentUsable: true, speechProviderIsNone: true, voiceEnabled: true },
    },
    {
      name: "voice is disabled",
      env: { ...USABLE_ENV, NOTETAKER_AGENT_VOICE_ENABLED: "false" },
      expected: { agentUsable: true, speechProviderIsNone: false, voiceEnabled: false },
    },
  ])("returns null and warns once with booleans only when $name", ({ env, expected }) => {
    const { synthesizer, logger } = create(env);

    expect(synthesizer).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Notetaker meeting agent voice is configured but not usable",
      expected
    );

    const serialized = JSON.stringify(loggedCalls(logger));
    expect(serialized).not.toContain(FAKE_ELEVENLABS_KEY);
    expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(serialized).not.toContain(FAKE_RECALL_KEY);
    expect(serialized).not.toContain(FAKE_RECALL_SECRET);
  });
});

describe("moduleLoader", () => {
  it("binds the meeting agent speech synthesizer token", () => {
    expect(moduleLoader.token).toBe(NOTETAKER_DI_TOKENS.NOTETAKER_MEETING_AGENT_SPEECH_SYNTHESIZER);
  });
});
