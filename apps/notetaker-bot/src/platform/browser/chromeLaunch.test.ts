// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildChromeLaunchOptions, sanitizeBrowserError } from "./chromeLaunch";

describe("buildChromeLaunchOptions", () => {
  it("disables Playwright's SIGINT and SIGTERM handlers so the runner owns shutdown", () => {
    const launchOptions = buildChromeLaunchOptions({ channel: "chrome", headless: true });
    expect(launchOptions.handleSIGINT).toBe(false);
    expect(launchOptions.handleSIGTERM).toBe(false);
  });

  it("passes channel and headless through and keeps the audio launch args", () => {
    expect(buildChromeLaunchOptions({ channel: "msedge", headless: false })).toEqual({
      channel: "msedge",
      headless: false,
      args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
      handleSIGINT: false,
      handleSIGTERM: false,
    });
  });

  it("returns a fresh args array on every call", () => {
    const first = buildChromeLaunchOptions({ channel: "chrome", headless: true });
    first.args.push("--extra");
    expect(buildChromeLaunchOptions({ channel: "chrome", headless: true }).args).toHaveLength(2);
  });
});

describe("sanitizeBrowserError", () => {
  it("keeps the original class name in name and the operation in the message", () => {
    class TimeoutError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "TimeoutError";
      }
    }
    const sanitized = sanitizeBrowserError("click", new TimeoutError("waiting for locator"));
    expect(sanitized.name).toBe("TimeoutError");
    expect(sanitized.message).toBe("Meeting browser click failed (TimeoutError)");
  });

  it("never carries the original message", () => {
    const original = new Error("page.goto: https://meet.google.com/abc-defg-hij call log: secret");
    const sanitized = sanitizeBrowserError("goto", original);
    expect(sanitized.message).toBe("Meeting browser goto failed (Error)");
    expect(sanitized.message).not.toContain("meet.google.com");
    expect(sanitized.stack ?? "").not.toContain("secret");
  });

  it("reports unknown for values that are not errors", () => {
    const sanitized = sanitizeBrowserError("launch", "boom");
    expect(sanitized.name).toBe("unknown");
    expect(sanitized.message).toBe("Meeting browser launch failed (unknown)");
  });
});

describe("PlaywrightChromeLauncher source", () => {
  const source = readFileSync(new URL("./PlaywrightChromeLauncher.ts", import.meta.url), "utf8");

  it("launches through buildChromeLaunchOptions", () => {
    expect(source).toContain("buildChromeLaunchOptions(");
  });

  it("does not launch with an inline options literal", () => {
    expect(source).not.toContain("chromium.launch({");
  });
});
