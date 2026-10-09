import process from "node:process";
import type { NotetakerBotProviderDto, NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import { z } from "zod";

type NotetakerFakeScenario =
  | "happy"
  | "not_admitted"
  | "meeting_did_not_start"
  | "no_speech"
  | "removed_by_participant"
  | "interrupted"
  | "length_limit"
  | "link_unusable"
  | "manual";

type NotetakerConfig = {
  limits: {
    admissionTimeoutSeconds: number;
    noShowTimeoutSeconds: number;
    aloneTimeoutSeconds: number;
    maxDurationSeconds: number;
    joinLeadSeconds: number;
    heartbeatTimeoutSeconds: number;
    summaryMinWords: number;
  };
  enabledPlatforms: NotetakerPlatformDto[];
  // null means unset in production, which the feature reports as disabled
  botProvider: NotetakerBotProviderDto | null;
  botUrl: string | null;
  botSecret: string | null;
  summaryModel: string;
  // null means no key; getNotetakerSummaryGeneratorKind then picks the stub or the disabled generator
  anthropicApiKey: string | null;
  fakeScenario: NotetakerFakeScenario;
};

const DEFAULT_SUMMARY_MODEL = "claude-opus-5-5";
const DEFAULT_PLATFORMS: NotetakerPlatformDto[] = ["GOOGLE_MEET"];

const PLATFORMS = ["GOOGLE_MEET", "MICROSOFT_TEAMS"] as const satisfies readonly NotetakerPlatformDto[];

const BOT_PROVIDERS: Record<string, NotetakerBotProviderDto> = {
  self_hosted: "SELF_HOSTED",
  recall: "RECALL",
  fake: "FAKE",
};

const FAKE_SCENARIOS = [
  "happy",
  "not_admitted",
  "meeting_did_not_start",
  "no_speech",
  "removed_by_participant",
  "interrupted",
  "length_limit",
  "link_unusable",
  "manual",
] as const satisfies readonly NotetakerFakeScenario[];

// An empty `VAR=` line must count as unset; coercing "" to a number would silently yield 0.
const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const limitSchema = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .optional()
    .transform((value) => (value === undefined ? fallback : Number.parseInt(value, 10)));

const platformsSchema = z
  .string()
  .optional()
  .transform((value, ctx): NotetakerPlatformDto[] => {
    const tokens = (value ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return DEFAULT_PLATFORMS;

    const platforms: NotetakerPlatformDto[] = [];
    for (const token of tokens) {
      const platform = PLATFORMS.find((candidate) => candidate === token);
      if (!platform) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must only list ${PLATFORMS.join(", ")}` });
        return z.NEVER;
      }
      if (!platforms.includes(platform)) platforms.push(platform);
    }
    return platforms;
  });

const botProviderSchema = z
  .string()
  .optional()
  .transform((value, ctx): NotetakerBotProviderDto | undefined => {
    if (value === undefined) return undefined;
    const provider = Object.hasOwn(BOT_PROVIDERS, value) ? BOT_PROVIDERS[value] : undefined;
    if (!provider) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be one of self_hosted, recall, fake" });
      return z.NEVER;
    }
    return provider;
  });

const botUrlSchema = z
  .string()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must be an http or https URL")
  .optional()
  .transform((value) => value ?? null);

const configSchema = z.object({
  NOTETAKER_ADMISSION_TIMEOUT_SECONDS: limitSchema(600),
  NOTETAKER_NO_SHOW_TIMEOUT_SECONDS: limitSchema(900),
  NOTETAKER_ALONE_TIMEOUT_SECONDS: limitSchema(120),
  NOTETAKER_MAX_DURATION_SECONDS: limitSchema(14400),
  NOTETAKER_JOIN_LEAD_SECONDS: limitSchema(120),
  NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS: limitSchema(180),
  NOTETAKER_SUMMARY_MIN_WORDS: limitSchema(40),
  NOTETAKER_ENABLED_PLATFORMS: platformsSchema,
  NOTETAKER_BOT_PROVIDER: botProviderSchema,
  NOTETAKER_BOT_URL: botUrlSchema,
  NOTETAKER_BOT_SECRET: z
    .string()
    .optional()
    .transform((value) => value ?? null),
  NOTETAKER_SUMMARY_MODEL: z
    .string()
    .optional()
    .transform((value) => value ?? DEFAULT_SUMMARY_MODEL),
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((value) => value ?? null),
  NOTETAKER_FAKE_SCENARIO: z
    .enum(FAKE_SCENARIOS)
    .optional()
    .transform((value): NotetakerFakeScenario => value ?? "happy"),
});

const getDefaultBotProvider = (env: NodeJS.ProcessEnv): NotetakerBotProviderDto | null => {
  if (env.NODE_ENV === "production") return null;
  return "FAKE";
};

const CONFIG_KEYS = Object.keys(configSchema.shape) as (keyof typeof configSchema.shape)[];

function getNotetakerConfig(env: NodeJS.ProcessEnv = process.env): NotetakerConfig {
  const raw: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) raw[key] = trimmedOrUndefined(env[key]);

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    // Only variable names and rules are reported, never values, so NOTETAKER_BOT_SECRET and ANTHROPIC_API_KEY cannot leak.
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw ErrorWithCode.Factory.InternalServerError(
      `Invalid notetaker configuration: ${problems.join("; ")}`
    );
  }

  const parsed = result.data;
  return {
    limits: {
      admissionTimeoutSeconds: parsed.NOTETAKER_ADMISSION_TIMEOUT_SECONDS,
      noShowTimeoutSeconds: parsed.NOTETAKER_NO_SHOW_TIMEOUT_SECONDS,
      aloneTimeoutSeconds: parsed.NOTETAKER_ALONE_TIMEOUT_SECONDS,
      maxDurationSeconds: parsed.NOTETAKER_MAX_DURATION_SECONDS,
      joinLeadSeconds: parsed.NOTETAKER_JOIN_LEAD_SECONDS,
      heartbeatTimeoutSeconds: parsed.NOTETAKER_HEARTBEAT_TIMEOUT_SECONDS,
      summaryMinWords: parsed.NOTETAKER_SUMMARY_MIN_WORDS,
    },
    enabledPlatforms: parsed.NOTETAKER_ENABLED_PLATFORMS,
    botProvider: parsed.NOTETAKER_BOT_PROVIDER ?? getDefaultBotProvider(env),
    botUrl: parsed.NOTETAKER_BOT_URL,
    botSecret: parsed.NOTETAKER_BOT_SECRET,
    summaryModel: parsed.NOTETAKER_SUMMARY_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    fakeScenario: parsed.NOTETAKER_FAKE_SCENARIO,
  };
}

function isNotetakerBotProviderUsable(
  config: NotetakerConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  switch (config.botProvider) {
    case null:
    // Recall is not built in v1, so no factory can produce it in any environment.
    case "RECALL":
      return false;
    case "FAKE":
      return env.NODE_ENV !== "production" || Boolean(trimmedOrUndefined(env.NEXT_PUBLIC_IS_E2E));
    case "SELF_HOSTED":
      return config.botUrl !== null && config.botSecret !== null;
  }
}

type NotetakerSummaryGeneratorKind = "ANTHROPIC" | "STUB" | "DISABLED";

function getNotetakerSummaryGeneratorKind(
  config: NotetakerConfig,
  env: NodeJS.ProcessEnv = process.env
): NotetakerSummaryGeneratorKind {
  if (config.anthropicApiKey !== null) return "ANTHROPIC";
  // The stub must never be chosen silently in production, where fake summaries would reach real users.
  if (env.NODE_ENV !== "production" || Boolean(trimmedOrUndefined(env.NEXT_PUBLIC_IS_E2E))) return "STUB";
  return "DISABLED";
}

const NOTETAKER_SWEEP_BATCH_SIZE = 200;

export type { NotetakerConfig, NotetakerFakeScenario, NotetakerSummaryGeneratorKind };
export {
  getNotetakerConfig,
  getNotetakerSummaryGeneratorKind,
  isNotetakerBotProviderUsable,
  NOTETAKER_SWEEP_BATCH_SIZE,
};
