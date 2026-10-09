// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getControllerConfig, getRunnerConfig, pickRunnerEnv, RUNNER_ENV_KEYS } from "./config";

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NOTETAKER_BOT_SECRET: "test-secret-not-real",
  ...overrides,
});

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

const PREFIX = "Invalid notetaker bot configuration: ";

describe("getControllerConfig", () => {
  it("controller: applies the template defaults", () => {
    expect(getControllerConfig(env())).toEqual({
      secret: "test-secret-not-real",
      host: "127.0.0.1",
      port: 4010,
      capacity: 10,
      launcher: "child_process",
      docker: null,
      adapterMode: "real",
      logLevel: "info",
    });
  });

  it("controller: treats empty and whitespace values as unset", () => {
    const defaults = getControllerConfig(env());
    const keys = [
      "NOTETAKER_BOT_HOST",
      "NOTETAKER_BOT_PORT",
      "NOTETAKER_BOT_CAPACITY",
      "NOTETAKER_BOT_LAUNCHER",
      "NOTETAKER_RUNNER_IMAGE",
      "NOTETAKER_DOCKER_SOCKET",
      "NOTETAKER_DOCKER_NETWORK",
      "NOTETAKER_BOT_ADAPTER",
      "NOTETAKER_LOG_LEVEL",
    ];

    for (const blank of ["", "  "]) {
      const overrides: Record<string, string> = {};
      for (const key of keys) overrides[key] = blank;
      expect(getControllerConfig(env(overrides))).toEqual(defaults);
    }
  });

  it("controller: trims the secret", () => {
    expect(getControllerConfig(env({ NOTETAKER_BOT_SECRET: "  s  " })).secret).toBe("s");
  });

  it("controller: requires the secret", () => {
    const missing: NodeJS.ProcessEnv = {};

    expect(() => getControllerConfig(missing)).toThrow("NOTETAKER_BOT_SECRET: must be set");
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_SECRET: "" }))).toThrow(
      "NOTETAKER_BOT_SECRET: must be set"
    );
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_SECRET: "   " }))).toThrow(
      "NOTETAKER_BOT_SECRET: must be set"
    );
  });

  it("controller: parses port and capacity", () => {
    expect(getControllerConfig(env({ NOTETAKER_BOT_PORT: "0" })).port).toBe(0);
    expect(getControllerConfig(env({ NOTETAKER_BOT_PORT: "65535" })).port).toBe(65535);
    expect(getControllerConfig(env({ NOTETAKER_BOT_CAPACITY: "1" })).capacity).toBe(1);
  });

  it("controller: rejects a bad port or capacity", () => {
    for (const port of ["65536", "-1", "4010.5", "abc"]) {
      expect(() => getControllerConfig(env({ NOTETAKER_BOT_PORT: port }))).toThrow(
        "NOTETAKER_BOT_PORT: must be an integer from 0 to 65535"
      );
    }
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_CAPACITY: "0" }))).toThrow(
      "NOTETAKER_BOT_CAPACITY: must be an integer of at least 1"
    );
  });

  it("controller: rejects an unknown launcher, adapter or log level", () => {
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_LAUNCHER: "kubernetes" }))).toThrow(
      "NOTETAKER_BOT_LAUNCHER: must be one of child_process, docker"
    );
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_ADAPTER: "mock" }))).toThrow(
      "NOTETAKER_BOT_ADAPTER: must be one of real, fake"
    );
    expect(() => getControllerConfig(env({ NOTETAKER_LOG_LEVEL: "verbose" }))).toThrow(
      "NOTETAKER_LOG_LEVEL: must be one of debug, info, warn, error, silent"
    );
    expect(() =>
      getControllerConfig(env({ NOTETAKER_BOT_LAUNCHER: "Docker", NOTETAKER_RUNNER_IMAGE: "img:1" }))
    ).toThrow("NOTETAKER_BOT_LAUNCHER: must be one of child_process, docker");
  });

  it("controller: builds the docker block", () => {
    expect(
      getControllerConfig(env({ NOTETAKER_BOT_LAUNCHER: "docker", NOTETAKER_RUNNER_IMAGE: "runner:1" }))
        .docker
    ).toEqual({ image: "runner:1", socketPath: "/var/run/docker.sock", networkMode: null });

    expect(
      getControllerConfig(
        env({
          NOTETAKER_BOT_LAUNCHER: "docker",
          NOTETAKER_RUNNER_IMAGE: "runner:1",
          NOTETAKER_DOCKER_SOCKET: "/tmp/test-docker.sock",
          NOTETAKER_DOCKER_NETWORK: "notetaker-net",
        })
      ).docker
    ).toEqual({ image: "runner:1", socketPath: "/tmp/test-docker.sock", networkMode: "notetaker-net" });
  });

  it("controller: requires the image for the docker launcher", () => {
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_LAUNCHER: "docker" }))).toThrow(
      "NOTETAKER_RUNNER_IMAGE: must be set when NOTETAKER_BOT_LAUNCHER is docker"
    );
  });

  it("controller: ignores docker variables for the child process launcher", () => {
    const config = getControllerConfig(
      env({ NOTETAKER_BOT_LAUNCHER: "child_process", NOTETAKER_RUNNER_IMAGE: "runner:1" })
    );

    expect(config.launcher).toBe("child_process");
    expect(config.docker).toBeNull();
  });

  it("controller: ignores variables only the runner reads", () => {
    expect(() => getControllerConfig(env({ SONIOX_WS_URL: "nope" }))).not.toThrow();
  });

  it("controller: refuses the fake adapter in production", () => {
    expect(() => getControllerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake", NODE_ENV: "production" }))).toThrow(
      "NOTETAKER_BOT_ADAPTER: must not be fake when NODE_ENV is production"
    );
    expect(
      getControllerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake", NODE_ENV: "development" })).adapterMode
    ).toBe("fake");
    expect(getControllerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake" })).adapterMode).toBe("fake");
  });
});

describe("configuration errors", () => {
  it("lists every problem in one error", () => {
    const missing: NodeJS.ProcessEnv = {
      NOTETAKER_BOT_PORT: "abc",
      NOTETAKER_BOT_LAUNCHER: "kubernetes",
    };

    expect(() => getControllerConfig(missing)).toThrow(
      `${PREFIX}NOTETAKER_BOT_SECRET: must be set; NOTETAKER_BOT_PORT: must be an integer from 0 to 65535; NOTETAKER_BOT_LAUNCHER: must be one of child_process, docker`
    );
  });

  it("never echoes a value", () => {
    const controllerEnv = env({
      NOTETAKER_BOT_PORT: "SENTINEL_VALUE_1",
      NOTETAKER_BOT_CAPACITY: "SENTINEL_VALUE_2",
      NOTETAKER_BOT_LAUNCHER: "SENTINEL_VALUE_3",
      NOTETAKER_BOT_ADAPTER: "SENTINEL_VALUE_4",
      NOTETAKER_LOG_LEVEL: "SENTINEL_VALUE_5",
    });
    const runnerEnv = env({
      NOTETAKER_BOT_ADAPTER: "SENTINEL_VALUE_6",
      NOTETAKER_FAKE_MEETING_SECONDS: "SENTINEL_VALUE_7",
      SONIOX_WS_URL: "SENTINEL_VALUE_8",
      NOTETAKER_GOOGLE_JOIN_MODE: "SENTINEL_VALUE_9",
      NOTETAKER_GOOGLE_STORAGE_STATE_B64: "SENTINEL_VALUE_10",
      NOTETAKER_CHROME_HEADLESS: "SENTINEL_VALUE_11",
      NOTETAKER_LOG_LEVEL: "SENTINEL_VALUE_12",
    });

    const messages: string[] = [];
    for (const attempt of [() => getControllerConfig(controllerEnv), () => getRunnerConfig(runnerEnv)]) {
      try {
        attempt();
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain("SENTINEL_VALUE");
    }
  });
});

describe("getRunnerConfig", () => {
  it("runner: applies the template defaults in real mode", () => {
    expect(getRunnerConfig(env({ SONIOX_API_KEY: "test-soniox-key-not-real" }))).toEqual({
      secret: "test-secret-not-real",
      adapterMode: "real",
      fakeMeetingSeconds: 5,
      soniox: { apiKey: "test-soniox-key-not-real", url: null, model: null },
      google: { joinMode: "guest", storageState: null, email: null, password: null },
      chrome: { channel: "chrome", headless: false },
      logLevel: "info",
    });
  });

  it("runner: requires the Soniox key in real mode", () => {
    expect(() => getRunnerConfig(env())).toThrow(
      "SONIOX_API_KEY: must be set when NOTETAKER_BOT_ADAPTER is real"
    );
  });

  it("runner: fake mode needs no key and yields no Soniox block", () => {
    expect(getRunnerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake" })).soniox).toBeNull();
    expect(
      getRunnerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake", SONIOX_API_KEY: "test-soniox-key-not-real" }))
        .soniox
    ).toBeNull();
  });

  it("runner: rejects a Soniox URL that is not ws or wss", () => {
    const base = { SONIOX_API_KEY: "test-soniox-key-not-real" };

    for (const url of ["https://stt.example.test/ws", "x"]) {
      expect(() => getRunnerConfig(env({ ...base, SONIOX_WS_URL: url }))).toThrow(
        "SONIOX_WS_URL: must be a ws or wss URL"
      );
    }
    expect(getRunnerConfig(env({ ...base, SONIOX_WS_URL: "wss://stt.example.test/ws" })).soniox?.url).toBe(
      "wss://stt.example.test/ws"
    );
  });

  it("runner: refuses the fake adapter in production", () => {
    expect(() => getRunnerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake", NODE_ENV: "production" }))).toThrow(
      "NOTETAKER_BOT_ADAPTER: must not be fake when NODE_ENV is production"
    );
    expect(getRunnerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake", NODE_ENV: "development" })).adapterMode).toBe(
      "fake"
    );
    expect(getRunnerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake" })).adapterMode).toBe("fake");
  });

  it("runner: parses the headless flag strictly", () => {
    const fake = { NOTETAKER_BOT_ADAPTER: "fake" };

    expect(getRunnerConfig(env({ ...fake, NOTETAKER_CHROME_HEADLESS: "true" })).chrome.headless).toBe(true);
    for (const value of ["1", "TRUE", "yes"]) {
      expect(() => getRunnerConfig(env({ ...fake, NOTETAKER_CHROME_HEADLESS: value }))).toThrow(
        "NOTETAKER_CHROME_HEADLESS: must be true or false"
      );
    }
  });

  it("runner: rejects bad fake meeting seconds", () => {
    for (const value of ["0", "x"]) {
      expect(() =>
        getRunnerConfig(env({ NOTETAKER_BOT_ADAPTER: "fake", NOTETAKER_FAKE_MEETING_SECONDS: value }))
      ).toThrow("NOTETAKER_FAKE_MEETING_SECONDS: must be an integer of at least 1");
    }
  });

  it("runner: decodes the storage state into an object", () => {
    const config = getRunnerConfig(
      env({
        NOTETAKER_BOT_ADAPTER: "fake",
        NOTETAKER_GOOGLE_JOIN_MODE: "account",
        NOTETAKER_GOOGLE_STORAGE_STATE_B64: b64('{"cookies":[],"origins":[]}'),
      })
    );

    expect(config.google.joinMode).toBe("account");
    expect(config.google.storageState).toEqual({ cookies: [], origins: [] });
  });

  it("runner: rejects a storage state that is not base64 of a JSON object", () => {
    const invalid = ["***", b64("not json"), b64("[]"), b64("null"), b64('"str"')];

    for (const value of invalid) {
      for (const mode of ["guest", "account"]) {
        expect(() =>
          getRunnerConfig(
            env({
              NOTETAKER_BOT_ADAPTER: "fake",
              NOTETAKER_GOOGLE_JOIN_MODE: mode,
              NOTETAKER_GOOGLE_STORAGE_STATE_B64: value,
            })
          )
        ).toThrow("NOTETAKER_GOOGLE_STORAGE_STATE_B64: must be base64 of a JSON object");
      }
    }
  });

  it("runner: account mode accepts email and password", () => {
    const config = getRunnerConfig(
      env({
        NOTETAKER_BOT_ADAPTER: "fake",
        NOTETAKER_GOOGLE_JOIN_MODE: "account",
        NOTETAKER_GOOGLE_ACCOUNT_EMAIL: "bot@example.test",
        NOTETAKER_GOOGLE_ACCOUNT_PASSWORD: "test-password-not-real",
      })
    );

    expect(config.google).toEqual({
      joinMode: "account",
      storageState: null,
      email: "bot@example.test",
      password: "test-password-not-real",
    });
  });

  it("runner: account mode needs a storage state or both credentials", () => {
    const rule =
      "NOTETAKER_GOOGLE_JOIN_MODE: account needs NOTETAKER_GOOGLE_STORAGE_STATE_B64 or both NOTETAKER_GOOGLE_ACCOUNT_EMAIL and NOTETAKER_GOOGLE_ACCOUNT_PASSWORD";
    const base = { NOTETAKER_BOT_ADAPTER: "fake", NOTETAKER_GOOGLE_JOIN_MODE: "account" };

    expect(() => getRunnerConfig(env(base))).toThrow(rule);
    expect(() =>
      getRunnerConfig(env({ ...base, NOTETAKER_GOOGLE_ACCOUNT_EMAIL: "bot@example.test" }))
    ).toThrow(rule);
  });

  it("runner: guest mode drops Google credentials", () => {
    const config = getRunnerConfig(
      env({
        NOTETAKER_BOT_ADAPTER: "fake",
        NOTETAKER_GOOGLE_JOIN_MODE: "guest",
        NOTETAKER_GOOGLE_STORAGE_STATE_B64: b64('{"cookies":[],"origins":[]}'),
        NOTETAKER_GOOGLE_ACCOUNT_EMAIL: "bot@example.test",
        NOTETAKER_GOOGLE_ACCOUNT_PASSWORD: "test-password-not-real",
      })
    );

    expect(config.google).toEqual({ joinMode: "guest", storageState: null, email: null, password: null });
  });
});

describe("RUNNER_ENV_KEYS", () => {
  it("RUNNER_ENV_KEYS lists what the runner reads plus NODE_ENV and TZ", () => {
    expect(RUNNER_ENV_KEYS).toEqual([
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
    ]);
    expect(RUNNER_ENV_KEYS).not.toContain("NOTETAKER_BOT_PORT");
    expect(RUNNER_ENV_KEYS).not.toContain("NOTETAKER_RUNNER_IMAGE");
    expect(RUNNER_ENV_KEYS).not.toContain("PATH");
  });
});

describe("pickRunnerEnv", () => {
  it("pickRunnerEnv forwards only allowlisted, non-empty variables", () => {
    const input: NodeJS.ProcessEnv = {
      NOTETAKER_BOT_SECRET: "  test-secret-not-real ",
      NOTETAKER_BOT_ADAPTER: "fake",
      SONIOX_API_KEY: "",
      SONIOX_MODEL: "test-model",
      NOTETAKER_LOG_LEVEL: "",
      NODE_ENV: "development",
      TZ: "UTC",
      PATH: "/usr/bin",
      NOTETAKER_BOT_PORT: "4010",
      AWS_SECRET_ACCESS_KEY: "test-aws-secret-not-real",
    };

    expect(pickRunnerEnv(input)).toEqual({
      NOTETAKER_BOT_SECRET: "  test-secret-not-real ",
      NOTETAKER_BOT_ADAPTER: "fake",
      SONIOX_MODEL: "test-model",
      NODE_ENV: "development",
      TZ: "UTC",
    });
  });
});
