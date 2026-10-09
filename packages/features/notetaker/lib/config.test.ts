import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNotetakerConfig,
  isNotetakerBotProviderUsable,
  NOTETAKER_SWEEP_BATCH_SIZE,
  type NotetakerConfig,
  type NotetakerFakeScenario,
} from "./config";

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ...overrides,
});

const limitRows = [
  ["NOTETAKER_ADMISSION_TIMEOUT_SECONDS", "admissionTimeoutSeconds", 600],
  ["NOTETAKER_NO_SHOW_TIMEOUT_SECONDS", "noShowTimeoutSeconds", 900],
  ["NOTETAKER_ALONE_TIMEOUT_SECONDS", "aloneTimeoutSeconds", 120],
  ["NOTETAKER_MAX_DURATION_SECONDS", "maxDurationSeconds", 14400],
  ["NOTETAKER_JOIN_LEAD_SECONDS", "joinLeadSeconds", 120],
  ["NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS", "heartbeatTimeoutSeconds", 180],
  ["NOTETAKER_SUMMARY_MIN_WORDS", "summaryMinWords", 40],
] as const;

const getError = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectConfigError = (overrides: Record<string, string | undefined>, variable: string) => {
  const error = getError(() => getNotetakerConfig(env(overrides)));
  expect(error).toBeInstanceOf(ErrorWithCode);
  expect((error as ErrorWithCode).message).toContain(variable);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getNotetakerConfig limits", () => {
  it.each(limitRows)("%s defaults when unset", (_name, field, fallback) => {
    expect(getNotetakerConfig(env()).limits[field]).toBe(fallback);
  });

  it.each(limitRows)("%s defaults when empty or whitespace", (name, field, fallback) => {
    expect(getNotetakerConfig(env({ [name]: "" })).limits[field]).toBe(fallback);
    expect(getNotetakerConfig(env({ [name]: "   " })).limits[field]).toBe(fallback);
  });

  it.each(limitRows)("%s parses a valid integer", (name, field) => {
    expect(getNotetakerConfig(env({ [name]: "45" })).limits[field]).toBe(45);
    expect(getNotetakerConfig(env({ [name]: " 7 " })).limits[field]).toBe(7);
  });

  it.each(limitRows)("%s accepts zero", (name, field) => {
    expect(getNotetakerConfig(env({ [name]: "0" })).limits[field]).toBe(0);
  });

  it.each(limitRows)("%s throws for non-numeric, negative, fractional and exponent values", (name) => {
    for (const value of ["abc", "-1", "1.5", "1e3"]) {
      expectConfigError({ [name]: value }, name);
    }
  });
});

describe("getNotetakerConfig platforms", () => {
  it("defaults to Google Meet", () => {
    expect(getNotetakerConfig(env()).enabledPlatforms).toEqual(["GOOGLE_MEET"]);
  });

  it("parses both platforms in order", () => {
    expect(
      getNotetakerConfig(env({ NOTETAKER_ENABLED_PLATFORMS: "GOOGLE_MEET,MICROSOFT_TEAMS" })).enabledPlatforms
    ).toEqual(["GOOGLE_MEET", "MICROSOFT_TEAMS"]);
  });

  it("tolerates whitespace and empty tokens", () => {
    expect(
      getNotetakerConfig(env({ NOTETAKER_ENABLED_PLATFORMS: " MICROSOFT_TEAMS , GOOGLE_MEET," }))
        .enabledPlatforms
    ).toEqual(["MICROSOFT_TEAMS", "GOOGLE_MEET"]);
  });

  it("falls back to the default when only empty tokens remain", () => {
    expect(getNotetakerConfig(env({ NOTETAKER_ENABLED_PLATFORMS: " , " })).enabledPlatforms).toEqual([
      "GOOGLE_MEET",
    ]);
  });

  it("removes duplicates keeping first-seen order", () => {
    expect(
      getNotetakerConfig(env({ NOTETAKER_ENABLED_PLATFORMS: "MICROSOFT_TEAMS,GOOGLE_MEET,MICROSOFT_TEAMS" }))
        .enabledPlatforms
    ).toEqual(["MICROSOFT_TEAMS", "GOOGLE_MEET"]);
  });

  it("throws for unknown or lowercase tokens", () => {
    expectConfigError({ NOTETAKER_ENABLED_PLATFORMS: "ZOOM" }, "NOTETAKER_ENABLED_PLATFORMS");
    expectConfigError({ NOTETAKER_ENABLED_PLATFORMS: "google_meet" }, "NOTETAKER_ENABLED_PLATFORMS");
    expectConfigError({ NOTETAKER_ENABLED_PLATFORMS: "GOOGLE_MEET,ZOOM" }, "NOTETAKER_ENABLED_PLATFORMS");
  });
});

describe("getNotetakerConfig bot provider", () => {
  it("maps the lowercase values", () => {
    expect(getNotetakerConfig(env({ NOTETAKER_BOT_PROVIDER: "self_hosted" })).botProvider).toBe(
      "SELF_HOSTED"
    );
    expect(getNotetakerConfig(env({ NOTETAKER_BOT_PROVIDER: "recall" })).botProvider).toBe("RECALL");
    expect(getNotetakerConfig(env({ NOTETAKER_BOT_PROVIDER: "fake" })).botProvider).toBe("FAKE");
  });

  it("throws for non-lowercase or unknown values", () => {
    for (const value of ["FAKE", "Self_Hosted", "zoom"]) {
      expectConfigError({ NOTETAKER_BOT_PROVIDER: value }, "NOTETAKER_BOT_PROVIDER");
    }
  });

  it("defaults to FAKE outside production", () => {
    expect(getNotetakerConfig(env({ NODE_ENV: "test" })).botProvider).toBe("FAKE");
    expect(getNotetakerConfig(env({ NODE_ENV: "development" })).botProvider).toBe("FAKE");
  });

  it("is null in production when unset or blank", () => {
    expect(getNotetakerConfig(env({ NODE_ENV: "production" })).botProvider).toBeNull();
    expect(
      getNotetakerConfig(env({ NODE_ENV: "production", NOTETAKER_BOT_PROVIDER: " " })).botProvider
    ).toBeNull();
  });
});

describe("getNotetakerConfig other fields", () => {
  it("defaults and overrides the summary model", () => {
    expect(getNotetakerConfig(env()).summaryModel).toBe("claude-opus-5-5");
    expect(getNotetakerConfig(env({ NOTETAKER_SUMMARY_MODEL: " custom-model " })).summaryModel).toBe(
      "custom-model"
    );
  });

  const scenarios: NotetakerFakeScenario[] = [
    "happy",
    "not_admitted",
    "meeting_did_not_start",
    "no_speech",
    "removed_by_participant",
    "interrupted",
    "length_limit",
    "link_unusable",
    "manual",
  ];

  it("defaults the fake scenario to happy", () => {
    expect(getNotetakerConfig(env()).fakeScenario).toBe("happy");
  });

  it.each(scenarios)("accepts fake scenario %s", (scenario) => {
    expect(getNotetakerConfig(env({ NOTETAKER_FAKE_SCENARIO: scenario })).fakeScenario).toBe(scenario);
  });

  it("throws for an unknown fake scenario", () => {
    expectConfigError({ NOTETAKER_FAKE_SCENARIO: "chaos" }, "NOTETAKER_FAKE_SCENARIO");
  });

  it("returns null bot url and secret when unset", () => {
    const config = getNotetakerConfig(env());
    expect(config.botUrl).toBeNull();
    expect(config.botSecret).toBeNull();
  });

  it("returns the bot url unchanged and the secret trimmed", () => {
    const config = getNotetakerConfig(
      env({ NOTETAKER_BOT_URL: " https://bot.example.com/api/ ", NOTETAKER_BOT_SECRET: " s3cr3t " })
    );
    expect(config.botUrl).toBe("https://bot.example.com/api/");
    expect(config.botSecret).toBe("s3cr3t");
  });

  it("throws for a malformed or non-http bot url", () => {
    expectConfigError({ NOTETAKER_BOT_URL: "not a url" }, "NOTETAKER_BOT_URL");
    expectConfigError({ NOTETAKER_BOT_URL: "ftp://bot.example.com" }, "NOTETAKER_BOT_URL");
  });

  it("never leaks the bot secret in a thrown error", () => {
    const error = getError(() =>
      getNotetakerConfig(env({ NOTETAKER_BOT_SECRET: "s3cr3t-value", NOTETAKER_JOIN_LEAD_SECONDS: "abc" }))
    ) as ErrorWithCode;
    expect(error).toBeInstanceOf(ErrorWithCode);
    expect(error.message).not.toContain("s3cr3t-value");
    expect(JSON.stringify(error.data ?? {})).not.toContain("s3cr3t-value");
  });

  it("exposes the sweep batch size", () => {
    expect(NOTETAKER_SWEEP_BATCH_SIZE).toBe(200);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("NOTETAKER_JOIN_LEAD_SECONDS", "30");
    expect(getNotetakerConfig().limits.joinLeadSeconds).toBe(30);
  });
});

describe("isNotetakerBotProviderUsable", () => {
  const configFor = (overrides: Record<string, string | undefined>) => getNotetakerConfig(env(overrides));
  const production = { NODE_ENV: "production" };

  it("is false in production when the provider is unset", () => {
    const e = env(production);
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(e), e)).toBe(false);
  });

  it("is false for FAKE in production without E2E", () => {
    const e = env({ ...production, NOTETAKER_BOT_PROVIDER: "fake" });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(e), e)).toBe(false);
    const blank = env({ ...production, NOTETAKER_BOT_PROVIDER: "fake", NEXT_PUBLIC_IS_E2E: " " });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(blank), blank)).toBe(false);
  });

  it("is true for FAKE in production when E2E is set", () => {
    const e = env({ ...production, NOTETAKER_BOT_PROVIDER: "fake", NEXT_PUBLIC_IS_E2E: "1" });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(e), e)).toBe(true);
  });

  it("is false for RECALL in every environment", () => {
    const prod = env({ ...production, NOTETAKER_BOT_PROVIDER: "recall" });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(prod), prod)).toBe(false);
    const dev = env({ NOTETAKER_BOT_PROVIDER: "recall" });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(dev), dev)).toBe(false);
  });

  it("is true for SELF_HOSTED with a url and secret", () => {
    const e = env({
      ...production,
      NOTETAKER_BOT_PROVIDER: "self_hosted",
      NOTETAKER_BOT_URL: "https://bot.example.com",
      NOTETAKER_BOT_SECRET: "secret",
    });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(e), e)).toBe(true);
  });

  it("is true for FAKE outside production", () => {
    const e = env();
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(e), e)).toBe(true);
  });

  it("is false for SELF_HOSTED missing the url or the secret", () => {
    const noUrl = env({ NOTETAKER_BOT_PROVIDER: "self_hosted", NOTETAKER_BOT_SECRET: "secret" });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(noUrl), noUrl)).toBe(false);
    const noSecret = env({
      NOTETAKER_BOT_PROVIDER: "self_hosted",
      NOTETAKER_BOT_URL: "https://bot.example.com",
    });
    expect(isNotetakerBotProviderUsable(getNotetakerConfig(noSecret), noSecret)).toBe(false);
  });

  it("is false for a hand-built config with a null provider", () => {
    const config: NotetakerConfig = { ...configFor({}), botProvider: null };
    expect(isNotetakerBotProviderUsable(config, env())).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_IS_E2E", "");
    expect(isNotetakerBotProviderUsable({ ...configFor({}), botProvider: "FAKE" })).toBe(false);
  });
});
