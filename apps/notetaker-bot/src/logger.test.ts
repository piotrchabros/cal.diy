// @vitest-environment node
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, createSilentLogger } from "./logger";

const lines: string[] = [];
const write = (line: string) => {
  lines.push(line);
};

const parse = (line: string | undefined): unknown => JSON.parse(line ?? "");

beforeEach(() => {
  lines.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("writes one JSON line with the reserved keys and the call fields", () => {
    createLogger({ write }).info("started", { sessionId: "s1", sequence: 3 });

    expect(lines).toHaveLength(1);
    expect(parse(lines[0])).toEqual({
      level: "info",
      time: "2030-01-01T10:00:00.000Z",
      message: "started",
      sessionId: "s1",
      sequence: 3,
    });
  });

  it("never writes a newline into the line, even when the message has one", () => {
    createLogger({ write }).info("first\nsecond");

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(parse(lines[0])).toEqual(expect.objectContaining({ message: "first\nsecond" }));
  });

  it("defaults to the info threshold", () => {
    const logger = createLogger({ write });

    logger.debug("d");
    expect(lines).toHaveLength(0);

    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((line) => parse(line))).toEqual([
      expect.objectContaining({ level: "info", message: "i" }),
      expect.objectContaining({ level: "warn", message: "w" }),
      expect.objectContaining({ level: "error", message: "e" }),
    ]);
  });

  it.each([
    { level: "debug", expected: 4 },
    { level: "info", expected: 3 },
    { level: "warn", expected: 2 },
    { level: "error", expected: 1 },
    { level: "silent", expected: 0 },
  ] as const)("level $level writes $expected lines", ({ level, expected }) => {
    const logger = createLogger({ level, write });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(lines).toHaveLength(expected);
  });

  it("only keeps warn and error at the warn threshold", () => {
    const logger = createLogger({ level: "warn", write });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(lines.map((line) => parse(line))).toEqual([
      expect.objectContaining({ level: "warn" }),
      expect.objectContaining({ level: "error" }),
    ]);
  });

  it("omits undefined fields and keeps null, false and zero", () => {
    createLogger({ write }).info("m", { a: undefined, b: null, c: false, d: 0 });

    const parsed = parse(lines[0]);
    expect(parsed).toEqual(expect.objectContaining({ b: null, c: false, d: 0 }));
    expect(parsed).not.toHaveProperty("a");
  });

  it("puts base fields on every line and lets a call field win", () => {
    const logger = createLogger({ write, base: { service: "bot", region: "eu" } });

    logger.info("one");
    logger.warn("two", { region: "us" });

    expect(parse(lines[0])).toEqual({
      level: "info",
      time: "2030-01-01T10:00:00.000Z",
      message: "one",
      service: "bot",
      region: "eu",
    });
    expect(parse(lines[1])).toEqual({
      level: "warn",
      time: "2030-01-01T10:00:00.000Z",
      message: "two",
      service: "bot",
      region: "us",
    });
  });

  it("does not let fields override the reserved keys", () => {
    createLogger({ write, base: { level: "base" } }).info("m", {
      level: "x",
      time: "y",
      message: "z",
    });

    expect(parse(lines[0])).toEqual({
      level: "info",
      time: "2030-01-01T10:00:00.000Z",
      message: "m",
    });
  });

  it("has a compile-time restriction to scalar fields", () => {
    const logger = createLogger({ write });

    // Fields are scalars so that a request body or an event cannot be logged by accident.
    // @ts-expect-error nested objects are not valid log fields
    logger.info("m", { body: { nested: true } });

    expect(lines).toHaveLength(1);
  });
});

describe("child", () => {
  it("adds fields to the child's lines only", () => {
    const parent = createLogger({ write });
    const child = parent.child({ sessionId: "s1" });

    child.info("from child");
    parent.info("from parent");

    expect(parse(lines[0])).toEqual(expect.objectContaining({ sessionId: "s1" }));
    expect(parse(lines[1])).not.toHaveProperty("sessionId");
  });

  it("lets child fields override base and call fields override child fields", () => {
    const child = createLogger({ write, base: { a: "base", b: "base" } }).child({ a: "child", b: "child" });

    child.info("m", { b: "call" });

    expect(parse(lines[0])).toEqual(expect.objectContaining({ a: "child", b: "call" }));
  });

  it("accumulates fields across nested children", () => {
    const grandchild = createLogger({ write, base: { a: 1 } })
      .child({ b: 2 })
      .child({ c: 3 });

    grandchild.info("m");

    expect(parse(lines[0])).toEqual({
      level: "info",
      time: "2030-01-01T10:00:00.000Z",
      message: "m",
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it("uses the parent's sink and threshold", () => {
    const child = createLogger({ level: "warn", write }).child({ a: 1 });

    child.info("hidden");
    expect(lines).toHaveLength(0);

    child.warn("shown");
    expect(lines).toHaveLength(1);
  });
});

describe("default sink", () => {
  it("writes one newline-terminated line to stderr and nothing to stdout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    createLogger().warn("w");

    expect(stderr).toHaveBeenCalledTimes(1);
    const written = stderr.mock.calls[0]?.[0];
    expect(typeof written).toBe("string");
    expect(written).toMatch(/[^\n]\n$/);
    expect(parse(String(written).trim())).toEqual(expect.objectContaining({ level: "warn", message: "w" }));
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("createSilentLogger", () => {
  it("writes nothing to either stream", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createSilentLogger();

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.child({ a: 1 }).error("c");

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
});
