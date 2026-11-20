import { z } from "zod";
import type { LogLevel } from "./logger";

type AgentBrowserConfig = {
  secret: string;
  host: string;
  controlPort: number;
  viewerPort: number;
  maxSessions: number;
  idleTimeoutSeconds: number;
  maxSessionSeconds: number;
  screencastFps: number;
  jpegQuality: number;
  chromiumSandbox: boolean;
  logLevel: LogLevel;
};

const MIN_SECRET_LENGTH = 32;
const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const satisfies readonly LogLevel[];

// Problems are reported in this order, whichever rule found them.
const VARIABLE_ORDER = [
  "AGENT_BROWSER_SECRET",
  "AGENT_BROWSER_HOST",
  "AGENT_BROWSER_CONTROL_PORT",
  "AGENT_BROWSER_VIEWER_PORT",
  "AGENT_BROWSER_MAX_SESSIONS",
  "AGENT_BROWSER_IDLE_TIMEOUT_SECONDS",
  "AGENT_BROWSER_MAX_SESSION_SECONDS",
  "AGENT_BROWSER_SCREENCAST_FPS",
  "AGENT_BROWSER_JPEG_QUALITY",
  "AGENT_BROWSER_CHROMIUM_SANDBOX",
  "AGENT_BROWSER_LOG_LEVEL",
];

// An empty `VAR=` line of an env file must count as unset, so it takes the default.
const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// Every rule carries its own fixed message: a Zod default message can echo the received value,
// and a value here may be the secret.
const fail = (ctx: z.RefinementCtx, message: string): never => {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  return z.NEVER;
};

const secretSchema = z
  .string()
  .optional()
  .transform((value, ctx): string => {
    if (value === undefined) return fail(ctx, "must be set");
    if (value.length < MIN_SECRET_LENGTH)
      return fail(ctx, `must be at least ${MIN_SECRET_LENGTH} characters`);
    return value;
  });

const textSchema = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => value ?? fallback);

const integerSchema = (fallback: number, range: { min: number; max: number }) =>
  z
    .string()
    .optional()
    .transform((value, ctx): number => {
      if (value === undefined) return fallback;
      const rule = `must be an integer from ${range.min} to ${range.max}`;
      if (!/^\d+$/.test(value)) return fail(ctx, rule);
      const parsed = Number.parseInt(value, 10);
      if (parsed < range.min || parsed > range.max) return fail(ctx, rule);
      return parsed;
    });

// 0 is allowed so tests can bind an ephemeral port.
const portSchema = (fallback: number) => integerSchema(fallback, { min: 0, max: 65535 });

const booleanSchema = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx): boolean => {
      if (value === undefined) return fallback;
      if (value === "true") return true;
      if (value === "false") return false;
      return fail(ctx, "must be true or false");
    });

const logLevelSchema = z
  .string()
  .optional()
  .transform((value, ctx): LogLevel => {
    if (value === undefined) return "info";
    const level = LOG_LEVELS.find((candidate) => candidate === value);
    return level ?? fail(ctx, `must be one of ${LOG_LEVELS.join(", ")}`);
  });

const fields = {
  AGENT_BROWSER_SECRET: secretSchema,
  // The service runs in its own container, where the published ports decide what is reachable.
  AGENT_BROWSER_HOST: textSchema("0.0.0.0"),
  AGENT_BROWSER_CONTROL_PORT: portSchema(4410),
  AGENT_BROWSER_VIEWER_PORT: portSchema(4411),
  AGENT_BROWSER_MAX_SESSIONS: integerSchema(4, { min: 1, max: 64 }),
  AGENT_BROWSER_IDLE_TIMEOUT_SECONDS: integerSchema(600, { min: 10, max: 86_400 }),
  AGENT_BROWSER_MAX_SESSION_SECONDS: integerSchema(18_000, { min: 60, max: 86_400 }),
  AGENT_BROWSER_SCREENCAST_FPS: integerSchema(12, { min: 1, max: 30 }),
  AGENT_BROWSER_JPEG_QUALITY: integerSchema(70, { min: 1, max: 100 }),
  AGENT_BROWSER_CHROMIUM_SANDBOX: booleanSchema(true),
  AGENT_BROWSER_LOG_LEVEL: logLevelSchema,
};

const schema = z.object(fields).superRefine((parsed, ctx) => {
  const { AGENT_BROWSER_CONTROL_PORT: control, AGENT_BROWSER_VIEWER_PORT: viewer } = parsed;
  // A port that already failed holds Zod's NEVER placeholder, which must not count as a clash.
  if (typeof control !== "number" || control === 0 || control !== viewer) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["AGENT_BROWSER_VIEWER_PORT"],
    message: "must differ from AGENT_BROWSER_CONTROL_PORT",
  });
});

function getAgentBrowserConfig(env: NodeJS.ProcessEnv): AgentBrowserConfig {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(fields)) raw[key] = trimmedOrUndefined(env[key]);

  const result = schema.safeParse(raw);
  if (!result.success) {
    // Only variable names and rule texts are reported, never values, so the secret cannot leak.
    const problems = result.error.issues
      .map((issue) => ({ name: String(issue.path[0]), rule: issue.message }))
      .sort((a, b) => VARIABLE_ORDER.indexOf(a.name) - VARIABLE_ORDER.indexOf(b.name))
      .map((problem) => `${problem.name}: ${problem.rule}`);
    throw new Error(`Invalid agent browser configuration: ${problems.join("; ")}`);
  }

  const parsed = result.data;
  return {
    secret: parsed.AGENT_BROWSER_SECRET,
    host: parsed.AGENT_BROWSER_HOST,
    controlPort: parsed.AGENT_BROWSER_CONTROL_PORT,
    viewerPort: parsed.AGENT_BROWSER_VIEWER_PORT,
    maxSessions: parsed.AGENT_BROWSER_MAX_SESSIONS,
    idleTimeoutSeconds: parsed.AGENT_BROWSER_IDLE_TIMEOUT_SECONDS,
    maxSessionSeconds: parsed.AGENT_BROWSER_MAX_SESSION_SECONDS,
    screencastFps: parsed.AGENT_BROWSER_SCREENCAST_FPS,
    jpegQuality: parsed.AGENT_BROWSER_JPEG_QUALITY,
    chromiumSandbox: parsed.AGENT_BROWSER_CHROMIUM_SANDBOX,
    logLevel: parsed.AGENT_BROWSER_LOG_LEVEL,
  };
}

export type { AgentBrowserConfig };
export { getAgentBrowserConfig };
