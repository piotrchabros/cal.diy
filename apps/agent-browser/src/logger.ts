import process from "node:process";

type EmittedLevel = Exclude<LogLevel, "silent">;

const RANKS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const writeToStdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(
  options: { level?: LogLevel; base?: LogFields; write?: (line: string) => void } = {}
): Logger {
  const level = options.level ?? "info";
  const base = options.base ?? {};
  const write = options.write ?? writeToStdout;

  const emit = (callLevel: EmittedLevel, message: string, fields?: LogFields): void => {
    if (RANKS[callLevel] < RANKS[level]) return;
    write(JSON.stringify({ ...base, ...fields, level: callLevel, time: new Date().toISOString(), message }));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, write }),
  };
}

export function createSilentLogger(): Logger {
  return createLogger({ level: "silent", write: () => {} });
}

// Query strings and fragments routinely carry session tokens, search terms and other things a
// participant typed, so only the origin and path of a visited URL ever reach the logs.
export function redactUrl(raw: string): string {
  if (!URL.canParse(raw)) return "[unparseable url]";
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}[redacted]`;
  return `${url.origin}${url.pathname}`;
}
