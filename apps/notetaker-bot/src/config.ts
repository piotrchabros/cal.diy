import { Buffer } from "node:buffer";
import { z } from "zod";
import type { LogLevel } from "./logger";

type LauncherName = "child_process" | "docker";
type AdapterMode = "real" | "fake";
type GoogleJoinMode = "guest" | "account";

type ControllerConfig = {
  secret: string;
  host: string;
  port: number;
  capacity: number;
  launcher: LauncherName;
  // non-null exactly when the launcher is docker
  docker: { image: string; socketPath: string; networkMode: string | null } | null;
  adapterMode: AdapterMode;
  logLevel: LogLevel;
};

type RunnerConfig = {
  secret: string;
  adapterMode: AdapterMode;
  fakeMeetingSeconds: number;
  // null exactly when the adapter is fake
  soniox: { apiKey: string; url: string | null; model: string | null } | null;
  google: {
    joinMode: GoogleJoinMode;
    storageState: unknown | null;
    email: string | null;
    password: string | null;
  };
  chrome: { channel: string; headless: boolean };
  logLevel: LogLevel;
};

const LAUNCHERS = ["child_process", "docker"] as const satisfies readonly LauncherName[];
const ADAPTER_MODES = ["real", "fake"] as const satisfies readonly AdapterMode[];
const GOOGLE_JOIN_MODES = ["guest", "account"] as const satisfies readonly GoogleJoinMode[];
const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const satisfies readonly LogLevel[];

// Problems are reported in this order, whichever rule found them.
const VARIABLE_ORDER = [
  "NOTETAKER_BOT_SECRET",
  "NOTETAKER_BOT_HOST",
  "NOTETAKER_BOT_PORT",
  "NOTETAKER_BOT_CAPACITY",
  "NOTETAKER_BOT_LAUNCHER",
  "NOTETAKER_RUNNER_IMAGE",
  "NOTETAKER_DOCKER_SOCKET",
  "NOTETAKER_DOCKER_NETWORK",
  "NOTETAKER_BOT_ADAPTER",
  "NOTETAKER_FAKE_MEETING_SECONDS",
  "SONIOX_API_KEY",
  "SONIOX_WS_URL",
  "SONIOX_MODEL",
  "NOTETAKER_GOOGLE_JOIN_MODE",
  "NOTETAKER_GOOGLE_STORAGE_STATE_B64",
  "NOTETAKER_GOOGLE_ACCOUNT_EMAIL",
  "NOTETAKER_GOOGLE_ACCOUNT_PASSWORD",
  "NOTETAKER_CHROME_CHANNEL",
  "NOTETAKER_CHROME_HEADLESS",
  "NOTETAKER_LOG_LEVEL",
  "NODE_ENV",
];

const RUNNER_ENV_KEYS: readonly string[] = [
  "NOTETAKER_BOT_SECRET",
  "NOTETAKER_BOT_ADAPTER",
  "NOTETAKER_FAKE_MEETING_SECONDS",
  "SONIOX_API_KEY",
  "SONIOX_WS_URL",
  "SONIOX_MODEL",
  "NOTETAKER_GOOGLE_JOIN_MODE",
  "NOTETAKER_GOOGLE_STORAGE_STATE_B64",
  "NOTETAKER_GOOGLE_ACCOUNT_EMAIL",
  "NOTETAKER_GOOGLE_ACCOUNT_PASSWORD",
  "NOTETAKER_CHROME_CHANNEL",
  "NOTETAKER_CHROME_HEADLESS",
  "NOTETAKER_LOG_LEVEL",
  "NODE_ENV",
  "TZ",
];

// An empty `VAR=` line of the template must count as unset, so it takes the default.
const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// Every rule carries its own fixed message: a Zod default message can echo the received value,
// and a value here may be a secret.
const fail = (ctx: z.RefinementCtx, message: string): never => {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  return z.NEVER;
};

const optionalSchema = z.string().optional();

const nullableSchema = z
  .string()
  .optional()
  .transform((value) => value ?? null);

const textSchema = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => value ?? fallback);

const requiredSchema = z
  .string()
  .optional()
  .transform((value, ctx): string => value ?? fail(ctx, "must be set"));

const oneOfSchema = <Option extends string>(options: readonly Option[], fallback: Option) =>
  z
    .string()
    .optional()
    .transform((value, ctx): Option => {
      if (value === undefined) return fallback;
      const option = options.find((candidate) => candidate === value);
      return option ?? fail(ctx, `must be one of ${options.join(", ")}`);
    });

const integerSchema = (fallback: number, range: { min: number; max: number }, rule: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx): number => {
      if (value === undefined) return fallback;
      if (!/^\d+$/.test(value)) return fail(ctx, rule);
      const parsed = Number.parseInt(value, 10);
      if (parsed < range.min || parsed > range.max) return fail(ctx, rule);
      return parsed;
    });

const atLeastOneSchema = (fallback: number) =>
  integerSchema(fallback, { min: 1, max: Number.MAX_SAFE_INTEGER }, "must be an integer of at least 1");

const headlessSchema = z
  .string()
  .optional()
  .transform((value, ctx): boolean => {
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    return fail(ctx, "must be true or false");
  });

const sonioxUrlSchema = z
  .string()
  .optional()
  .transform((value, ctx): string | null => {
    if (value === undefined) return null;
    if (!URL.canParse(value)) return fail(ctx, "must be a ws or wss URL");
    const protocol = new URL(value).protocol;
    if (protocol !== "ws:" && protocol !== "wss:") return fail(ctx, "must be a ws or wss URL");
    return value;
  });

const decodeStorageState = (encoded: string): Record<string, unknown> | null => {
  const compact = encoded.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(compact, "base64").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    return { ...decoded };
  } catch {
    return null;
  }
};

const storageStateSchema = z
  .string()
  .optional()
  .transform((value, ctx): Record<string, unknown> | null => {
    if (value === undefined) return null;
    return decodeStorageState(value) ?? fail(ctx, "must be base64 of a JSON object");
  });

const refuseFakeInProduction = (
  parsed: { NOTETAKER_BOT_ADAPTER: AdapterMode; NODE_ENV?: string },
  ctx: z.RefinementCtx
): void => {
  if (parsed.NOTETAKER_BOT_ADAPTER !== "fake" || parsed.NODE_ENV !== "production") return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["NOTETAKER_BOT_ADAPTER"],
    message: "must not be fake when NODE_ENV is production",
  });
};

const controllerFields = {
  NOTETAKER_BOT_SECRET: requiredSchema,
  NOTETAKER_BOT_HOST: textSchema("127.0.0.1"),
  // 0 is allowed so the server can bind an ephemeral port.
  NOTETAKER_BOT_PORT: integerSchema(4010, { min: 0, max: 65535 }, "must be an integer from 0 to 65535"),
  NOTETAKER_BOT_CAPACITY: atLeastOneSchema(10),
  NOTETAKER_BOT_LAUNCHER: oneOfSchema(LAUNCHERS, "child_process"),
  NOTETAKER_RUNNER_IMAGE: optionalSchema,
  NOTETAKER_DOCKER_SOCKET: textSchema("/var/run/docker.sock"),
  NOTETAKER_DOCKER_NETWORK: nullableSchema,
  NOTETAKER_BOT_ADAPTER: oneOfSchema(ADAPTER_MODES, "real"),
  NOTETAKER_LOG_LEVEL: oneOfSchema(LOG_LEVELS, "info"),
  NODE_ENV: optionalSchema,
};

const runnerFields = {
  NOTETAKER_BOT_SECRET: requiredSchema,
  NOTETAKER_BOT_ADAPTER: oneOfSchema(ADAPTER_MODES, "real"),
  NOTETAKER_FAKE_MEETING_SECONDS: atLeastOneSchema(5),
  SONIOX_API_KEY: optionalSchema,
  SONIOX_WS_URL: sonioxUrlSchema,
  SONIOX_MODEL: nullableSchema,
  NOTETAKER_GOOGLE_JOIN_MODE: oneOfSchema(GOOGLE_JOIN_MODES, "guest"),
  NOTETAKER_GOOGLE_STORAGE_STATE_B64: storageStateSchema,
  NOTETAKER_GOOGLE_ACCOUNT_EMAIL: nullableSchema,
  NOTETAKER_GOOGLE_ACCOUNT_PASSWORD: nullableSchema,
  NOTETAKER_CHROME_CHANNEL: textSchema("chrome"),
  NOTETAKER_CHROME_HEADLESS: headlessSchema,
  NOTETAKER_LOG_LEVEL: oneOfSchema(LOG_LEVELS, "info"),
  NODE_ENV: optionalSchema,
};

// The cross-field rules below also run when a field already failed. Such a field then holds
// Zod's NEVER placeholder, which equals none of the compared values, so a rule that depends on
// an invalid field stays quiet instead of reporting a second, misleading problem.
const controllerSchema = z.object(controllerFields).superRefine((parsed, ctx) => {
  if (parsed.NOTETAKER_BOT_LAUNCHER === "docker" && parsed.NOTETAKER_RUNNER_IMAGE === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NOTETAKER_RUNNER_IMAGE"],
      message: "must be set when NOTETAKER_BOT_LAUNCHER is docker",
    });
  }
  refuseFakeInProduction(parsed, ctx);
});

const runnerSchema = z.object(runnerFields).superRefine((parsed, ctx) => {
  refuseFakeInProduction(parsed, ctx);

  if (parsed.NOTETAKER_BOT_ADAPTER === "real" && parsed.SONIOX_API_KEY === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SONIOX_API_KEY"],
      message: "must be set when NOTETAKER_BOT_ADAPTER is real",
    });
  }

  const hasCredentials =
    parsed.NOTETAKER_GOOGLE_ACCOUNT_EMAIL !== null && parsed.NOTETAKER_GOOGLE_ACCOUNT_PASSWORD !== null;
  if (
    parsed.NOTETAKER_GOOGLE_JOIN_MODE === "account" &&
    parsed.NOTETAKER_GOOGLE_STORAGE_STATE_B64 === null &&
    !hasCredentials
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NOTETAKER_GOOGLE_JOIN_MODE"],
      message:
        "account needs NOTETAKER_GOOGLE_STORAGE_STATE_B64 or both NOTETAKER_GOOGLE_ACCOUNT_EMAIL and NOTETAKER_GOOGLE_ACCOUNT_PASSWORD",
    });
  }
});

function parseEnv<Schema extends z.ZodTypeAny>(
  schema: Schema,
  keys: string[],
  env: NodeJS.ProcessEnv
): z.output<Schema> {
  const raw: Record<string, string | undefined> = {};
  for (const key of keys) raw[key] = trimmedOrUndefined(env[key]);

  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  // Only variable names and rule texts are reported, never values, so no secret can leak.
  const problems = result.error.issues
    .map((issue) => ({ name: String(issue.path[0]), rule: issue.message }))
    .sort((a, b) => VARIABLE_ORDER.indexOf(a.name) - VARIABLE_ORDER.indexOf(b.name))
    .map((problem) => `${problem.name}: ${problem.rule}`);
  throw new Error(`Invalid notetaker bot configuration: ${problems.join("; ")}`);
}

function getControllerConfig(env: NodeJS.ProcessEnv): ControllerConfig {
  const parsed = parseEnv(controllerSchema, Object.keys(controllerFields), env);
  const image = parsed.NOTETAKER_RUNNER_IMAGE;

  return {
    secret: parsed.NOTETAKER_BOT_SECRET,
    host: parsed.NOTETAKER_BOT_HOST,
    port: parsed.NOTETAKER_BOT_PORT,
    capacity: parsed.NOTETAKER_BOT_CAPACITY,
    launcher: parsed.NOTETAKER_BOT_LAUNCHER,
    // The schema already refused a docker launcher without an image; the image check only narrows the type.
    docker:
      parsed.NOTETAKER_BOT_LAUNCHER === "docker" && image !== undefined
        ? {
            image,
            socketPath: parsed.NOTETAKER_DOCKER_SOCKET,
            networkMode: parsed.NOTETAKER_DOCKER_NETWORK,
          }
        : null,
    adapterMode: parsed.NOTETAKER_BOT_ADAPTER,
    logLevel: parsed.NOTETAKER_LOG_LEVEL,
  };
}

function getRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const parsed = parseEnv(runnerSchema, Object.keys(runnerFields), env);
  const apiKey = parsed.SONIOX_API_KEY;
  const isAccountJoin = parsed.NOTETAKER_GOOGLE_JOIN_MODE === "account";

  return {
    secret: parsed.NOTETAKER_BOT_SECRET,
    adapterMode: parsed.NOTETAKER_BOT_ADAPTER,
    fakeMeetingSeconds: parsed.NOTETAKER_FAKE_MEETING_SECONDS,
    // The schema already refused real mode without a key; the key check only narrows the type.
    soniox:
      parsed.NOTETAKER_BOT_ADAPTER === "real" && apiKey !== undefined
        ? { apiKey, url: parsed.SONIOX_WS_URL, model: parsed.SONIOX_MODEL }
        : null,
    // Guest mode drops every credential, so a guest join can never go in signed in.
    google: {
      joinMode: parsed.NOTETAKER_GOOGLE_JOIN_MODE,
      storageState: isAccountJoin ? parsed.NOTETAKER_GOOGLE_STORAGE_STATE_B64 : null,
      email: isAccountJoin ? parsed.NOTETAKER_GOOGLE_ACCOUNT_EMAIL : null,
      password: isAccountJoin ? parsed.NOTETAKER_GOOGLE_ACCOUNT_PASSWORD : null,
    },
    chrome: { channel: parsed.NOTETAKER_CHROME_CHANNEL, headless: parsed.NOTETAKER_CHROME_HEADLESS },
    logLevel: parsed.NOTETAKER_LOG_LEVEL,
  };
}

function pickRunnerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of RUNNER_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value !== "") picked[key] = value;
  }
  return picked;
}

export type { ControllerConfig, RunnerConfig };
export { getControllerConfig, getRunnerConfig, pickRunnerEnv, RUNNER_ENV_KEYS };
