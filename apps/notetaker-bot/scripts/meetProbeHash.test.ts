// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSourceId,
  hashProbeValue,
  hashSourceKey,
  PROBE_HASH_LENGTH,
  PROBE_HASH_PATTERN,
  PROBE_SALT_PATTERN,
  sourceIdOfKey,
} from "./meetProbeHash";

const SALT = "ab".repeat(32);

describe("hashProbeValue", () => {
  it("is the first 16 hex characters of the salted SHA-256", () => {
    const expected = createHash("sha256")
      .update(`${SALT}|pid|spaces/q1/devices/111`)
      .digest("hex")
      .slice(0, 16);
    expect(hashProbeValue(SALT, "pid", "spaces/q1/devices/111")).toBe(expected);
    expect(PROBE_HASH_LENGTH).toBe(16);
    expect(hashProbeValue(SALT, "pid", "x")).toMatch(PROBE_HASH_PATTERN);
  });

  it("hashes non-ASCII values as UTF-8", () => {
    const value = "spaces/zażółć/devices/1";
    const expected = createHash("sha256").update(`${SALT}|src|${value}`, "utf8").digest("hex").slice(0, 16);
    expect(hashProbeValue(SALT, "src", value)).toBe(expected);
  });

  it("differs by salt, by domain and by value", () => {
    const base = hashProbeValue(SALT, "src", "7");
    expect(hashProbeValue("cd".repeat(32), "src", "7")).not.toBe(base);
    expect(hashProbeValue(SALT, "pid", "7")).not.toBe(base);
    expect(hashProbeValue(SALT, "src", "8")).not.toBe(base);
  });

  it("throws on a salt that is empty, short, long or upper-case", () => {
    for (const salt of ["", "ab".repeat(31), "ab".repeat(33), "AB".repeat(32), "zz".repeat(32)]) {
      expect(() => hashProbeValue(salt, "src", "7")).toThrow(/salt/i);
    }
  });

  it("exposes a salt pattern of 64 lower-case hex characters", () => {
    expect(PROBE_SALT_PATTERN.test(SALT)).toBe(true);
    expect(PROBE_SALT_PATTERN.test("AB".repeat(32))).toBe(false);
    expect(PROBE_SALT_PATTERN.test("ab".repeat(31))).toBe(false);
  });
});

describe("canonicalSourceId", () => {
  it("drops leading zeros and surrounding whitespace of numbers", () => {
    expect(canonicalSourceId(" 007 ")).toBe("7");
    expect(canonicalSourceId("0314")).toBe("314");
    expect(canonicalSourceId("0")).toBe("0");
  });

  it("keeps a 32-bit maximum number", () => {
    expect(canonicalSourceId("4294967295")).toBe("4294967295");
  });

  it("keeps an 11-digit or non-numeric value as trimmed text", () => {
    expect(canonicalSourceId("12345678901")).toBe("12345678901");
    expect(canonicalSourceId("  ab12  ")).toBe("ab12");
  });

  it("returns null when nothing is left", () => {
    expect(canonicalSourceId("")).toBeNull();
    expect(canonicalSourceId("  ")).toBeNull();
  });

  it("cuts long text to 256 characters", () => {
    expect(canonicalSourceId("x".repeat(300))).toBe("x".repeat(256));
  });
});

describe("hashSourceKey", () => {
  it("gives csrc and ssrc keys the same hash part with their own prefix", () => {
    const hash = hashProbeValue(SALT, "src", "7");
    expect(hashSourceKey(SALT, "csrc:7")).toBe(`csrc:${hash}`);
    expect(hashSourceKey(SALT, "ssrc:7")).toBe(`ssrc:${hash}`);
  });

  it("canonicalises the number so leading zeros hash alike", () => {
    expect(hashSourceKey(SALT, "csrc:007")).toBe(hashSourceKey(SALT, "csrc:7"));
  });

  it("hashes any other key whole under the other prefix", () => {
    const result = hashSourceKey(SALT, "ssrc-1");
    expect(result).toBe(`other:${hashProbeValue(SALT, "src", "ssrc-1")}`);
    expect(result).toMatch(/^other:[0-9a-f]{16}$/);
  });

  it("does not leave the raw number in the result", () => {
    expect(hashSourceKey(SALT, "csrc:2718281828")).not.toContain("2718281828");
  });
});

describe("sourceIdOfKey", () => {
  it("returns the canonical number of a csrc or ssrc key", () => {
    expect(sourceIdOfKey("csrc:007")).toBe("7");
    expect(sourceIdOfKey("ssrc:2718281828")).toBe("2718281828");
  });

  it("returns null for any other key", () => {
    expect(sourceIdOfKey("ssrc-1")).toBeNull();
    expect(sourceIdOfKey("csrc:")).toBeNull();
    expect(sourceIdOfKey("csrc:abc")).toBeNull();
    expect(sourceIdOfKey("other:7")).toBeNull();
  });
});
