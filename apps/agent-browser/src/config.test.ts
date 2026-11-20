// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getAgentBrowserConfig } from "./config";

const SECRET = "test-secret-not-real-0123456789abcdef";

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AGENT_BROWSER_SECRET: SECRET,
  ...overrides,
});

describe("getAgentBrowserConfig", () => {
  it("applies the defaults", () => {
    expect(getAgentBrowserConfig(env())).toEqual({
      secret: SECRET,
      host: "0.0.0.0",
      controlPort: 4410,
      viewerPort: 4411,
      maxSessions: 4,
      idleTimeoutSeconds: 600,
      maxSessionSeconds: 18_000,
      screencastFps: 12,
      jpegQuality: 70,
      chromiumSandbox: true,
      logLevel: "info",
    });
  });

  it("reads every variable", () => {
    expect(
      getAgentBrowserConfig(
        env({
          AGENT_BROWSER_HOST: "127.0.0.1",
          AGENT_BROWSER_CONTROL_PORT: "5000",
          AGENT_BROWSER_VIEWER_PORT: "5001",
          AGENT_BROWSER_MAX_SESSIONS: "2",
          AGENT_BROWSER_IDLE_TIMEOUT_SECONDS: "120",
          AGENT_BROWSER_MAX_SESSION_SECONDS: "3600",
          AGENT_BROWSER_SCREENCAST_FPS: "15",
          AGENT_BROWSER_JPEG_QUALITY: "50",
          AGENT_BROWSER_CHROMIUM_SANDBOX: "false",
          AGENT_BROWSER_LOG_LEVEL: "debug",
        })
      )
    ).toEqual({
      secret: SECRET,
      host: "127.0.0.1",
      controlPort: 5000,
      viewerPort: 5001,
      maxSessions: 2,
      idleTimeoutSeconds: 120,
      maxSessionSeconds: 3600,
      screencastFps: 15,
      jpegQuality: 50,
      chromiumSandbox: false,
      logLevel: "debug",
    });
  });

  it("treats empty and whitespace values as unset", () => {
    const defaults = getAgentBrowserConfig(env());
    const keys = [
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

    for (const blank of ["", "  "]) {
      const overrides: Record<string, string> = {};
      for (const key of keys) overrides[key] = blank;
      expect(getAgentBrowserConfig(env(overrides))).toEqual(defaults);
    }
  });

  it("requires the secret", () => {
    expect(() => getAgentBrowserConfig({})).toThrow("AGENT_BROWSER_SECRET: must be set");
    expect(() => getAgentBrowserConfig(env({ AGENT_BROWSER_SECRET: "   " }))).toThrow(
      "AGENT_BROWSER_SECRET: must be set"
    );
  });

  it("rejects a short secret without echoing it", () => {
    const short = "short-secret-value";

    expect(() => getAgentBrowserConfig(env({ AGENT_BROWSER_SECRET: short }))).toThrow(
      "AGENT_BROWSER_SECRET: must be at least 32 characters"
    );
    expect(() => getAgentBrowserConfig(env({ AGENT_BROWSER_SECRET: short }))).not.toThrow(short);
  });

  it("measures the secret after trimming", () => {
    const padded = `  ${"a".repeat(31)}  `;

    expect(() => getAgentBrowserConfig(env({ AGENT_BROWSER_SECRET: padded }))).toThrow(
      "AGENT_BROWSER_SECRET: must be at least 32 characters"
    );
    expect(getAgentBrowserConfig(env({ AGENT_BROWSER_SECRET: `  ${SECRET}  ` })).secret).toBe(SECRET);
  });

  it.each(["-1", "65536", "abc", "1.5", "4410x"])("rejects the port %s", (port) => {
    expect(() => getAgentBrowserConfig(env({ AGENT_BROWSER_CONTROL_PORT: port }))).toThrow(
      "AGENT_BROWSER_CONTROL_PORT: must be an integer from 0 to 65535"
    );
    expect(() => getAgentBrowserConfig(env({ AGENT_BROWSER_VIEWER_PORT: port }))).toThrow(
      "AGENT_BROWSER_VIEWER_PORT: must be an integer from 0 to 65535"
    );
  });

  it("rejects equal control and viewer ports but allows two ephemeral ports", () => {
    expect(() =>
      getAgentBrowserConfig(env({ AGENT_BROWSER_CONTROL_PORT: "5000", AGENT_BROWSER_VIEWER_PORT: "5000" }))
    ).toThrow("AGENT_BROWSER_VIEWER_PORT: must differ from AGENT_BROWSER_CONTROL_PORT");

    const ephemeral = getAgentBrowserConfig(
      env({ AGENT_BROWSER_CONTROL_PORT: "0", AGENT_BROWSER_VIEWER_PORT: "0" })
    );
    expect([ephemeral.controlPort, ephemeral.viewerPort]).toEqual([0, 0]);
  });

  it.each([
    ["AGENT_BROWSER_MAX_SESSIONS", "0", "must be an integer from 1 to 64"],
    ["AGENT_BROWSER_IDLE_TIMEOUT_SECONDS", "5", "must be an integer from 10 to 86400"],
    ["AGENT_BROWSER_MAX_SESSION_SECONDS", "86401", "must be an integer from 60 to 86400"],
    ["AGENT_BROWSER_SCREENCAST_FPS", "31", "must be an integer from 1 to 30"],
    ["AGENT_BROWSER_JPEG_QUALITY", "0", "must be an integer from 1 to 100"],
    ["AGENT_BROWSER_CHROMIUM_SANDBOX", "yes", "must be true or false"],
    ["AGENT_BROWSER_LOG_LEVEL", "verbose", "must be one of debug, info, warn, error, silent"],
  ])("rejects %s=%s", (name, value, rule) => {
    expect(() => getAgentBrowserConfig(env({ [name]: value }))).toThrow(`${name}: ${rule}`);
  });

  it("reports every problem in variable order", () => {
    expect(() =>
      getAgentBrowserConfig({ AGENT_BROWSER_LOG_LEVEL: "loud", AGENT_BROWSER_CONTROL_PORT: "x" })
    ).toThrow(
      "Invalid agent browser configuration: AGENT_BROWSER_SECRET: must be set; " +
        "AGENT_BROWSER_CONTROL_PORT: must be an integer from 0 to 65535; " +
        "AGENT_BROWSER_LOG_LEVEL: must be one of debug, info, warn, error, silent"
    );
  });
});
