/** @vitest-environment node */

import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { describe, expect, it, vi } from "vitest";
import { getNotetakerConfig } from "../lib/config";
import { AnthropicSummaryGenerator } from "../summary/AnthropicSummaryGenerator";
import { DisabledSummaryGenerator } from "../summary/DisabledSummaryGenerator";
import { StubSummaryGenerator } from "../summary/StubSummaryGenerator";
import { createNotetakerSummaryGenerator, moduleLoader } from "./NotetakerSummaryGenerator.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const FAKE_KEY = "test-key-not-real";

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
  const generator = createNotetakerSummaryGenerator({ config: getNotetakerConfig(env), logger, env });
  return { generator, logger };
}

describe("createNotetakerSummaryGenerator", () => {
  it("returns the Anthropic generator without logging when a key is set", () => {
    const { generator, logger } = create({ NODE_ENV: "test", ANTHROPIC_API_KEY: FAKE_KEY });

    expect(generator).toBeInstanceOf(AnthropicSummaryGenerator);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns the Anthropic generator in production when a key is set", () => {
    const { generator } = create({ NODE_ENV: "production", ANTHROPIC_API_KEY: FAKE_KEY });

    expect(generator).toBeInstanceOf(AnthropicSummaryGenerator);
  });

  it("returns the stub outside production without a key and logs it", () => {
    const { generator, logger } = create({ NODE_ENV: "test" });

    expect(generator).toBeInstanceOf(StubSummaryGenerator);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Notetaker summary generator: stub (ANTHROPIC_API_KEY unset)");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns the disabled generator in production without a key and logs an error", () => {
    const { generator, logger } = create({ NODE_ENV: "production" });

    expect(generator).toBeInstanceOf(DisabledSummaryGenerator);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Notetaker summary generator disabled: ANTHROPIC_API_KEY is unset in production"
    );
  });

  it("returns the stub in production when running E2E", () => {
    const { generator } = create({ NODE_ENV: "production", NEXT_PUBLIC_IS_E2E: "1" });

    expect(generator).toBeInstanceOf(StubSummaryGenerator);
  });

  it("makes the disabled generator resolve a non-retryable GENERATOR_DISABLED failure", async () => {
    const { generator } = create({ NODE_ENV: "production" });

    await expect(generator.generate({ passages: [], languageHint: null })).resolves.toEqual({
      ok: false,
      failureCode: "GENERATOR_DISABLED",
      retryable: false,
    });
  });

  it("never logs the API key", () => {
    const { logger } = create({ NODE_ENV: "test", ANTHROPIC_API_KEY: FAKE_KEY });

    const calls = [
      ...logger.debug.mock.calls,
      ...logger.error.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
    ];
    expect(JSON.stringify(calls)).not.toContain(FAKE_KEY);
  });
});

describe("moduleLoader", () => {
  it("binds the summary generator token", () => {
    expect(moduleLoader.token).toBe(NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_GENERATOR);
  });
});
