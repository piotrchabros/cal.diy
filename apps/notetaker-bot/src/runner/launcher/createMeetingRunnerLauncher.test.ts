// @vitest-environment node
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { getControllerConfig, pickRunnerEnv, RUNNER_ENV_KEYS } from "../../config";
import { createSilentLogger } from "../../logger";
import { ChildProcessMeetingRunnerLauncher } from "./ChildProcessMeetingRunnerLauncher";
import { createMeetingRunnerLauncher, resolveRunnerMainPath } from "./createMeetingRunnerLauncher";
import type { DockerEngineClient } from "./DockerEngineClient";
import { DockerMeetingRunnerLauncher } from "./DockerMeetingRunnerLauncher";

type ChildDeps = ConstructorParameters<typeof ChildProcessMeetingRunnerLauncher>[0];
type DockerDeps = ConstructorParameters<typeof DockerMeetingRunnerLauncher>[0];
type EngineDeps = ConstructorParameters<typeof DockerEngineClient>[0];

const captures = vi.hoisted(() => ({
  child: [] as ChildDeps[],
  docker: [] as DockerDeps[],
  engine: [] as EngineDeps[],
}));

vi.mock("./ChildProcessMeetingRunnerLauncher", () => ({
  ChildProcessMeetingRunnerLauncher: class {
    constructor(deps: ChildDeps) {
      captures.child.push(deps);
    }
  },
}));

vi.mock("./DockerMeetingRunnerLauncher", () => ({
  DockerMeetingRunnerLauncher: class {
    constructor(deps: DockerDeps) {
      captures.docker.push(deps);
    }
  },
}));

vi.mock("./DockerEngineClient", () => ({
  DockerEngineClient: class {
    constructor(deps: EngineDeps) {
      captures.engine.push(deps);
    }
  },
}));

const MAIN_PATH = "/srv/bot/src/main.ts";
const RUNNER_PATH = "/srv/bot/src/runnerMain.ts";

const buildFullEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_ENV_KEYS) env[key] = `fake-${key}`;
  env.NOTETAKER_BOT_SECRET = "test-secret-not-real";
  env.NOTETAKER_BOT_ADAPTER = "fake";
  env.NOTETAKER_LOG_LEVEL = "silent";
  env.PATH = "/fake/bin";
  env.HOME = "/fake/home";
  env.DISPLAY = ":99";
  env.NOTETAKER_BOT_PORT = "4010";
  env.NOTETAKER_BOT_CAPACITY = "4";
  env.NOTETAKER_RUNNER_IMAGE = "notetaker-runner:test";
  env.NOTETAKER_DOCKER_SOCKET = "/tmp/fake-docker.sock";
  env.NOTETAKER_RUNNER_JOIN_REQUEST = "fake-join-request";
  env.UNRELATED_TOKEN = "fake-unrelated";
  return env;
};

const dockerEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NOTETAKER_BOT_SECRET: "test-secret-not-real",
  NOTETAKER_BOT_LAUNCHER: "docker",
  NOTETAKER_RUNNER_IMAGE: "notetaker-runner:test",
  NOTETAKER_DOCKER_SOCKET: "/tmp/fake-docker.sock",
  NOTETAKER_BOT_CAPACITY: "3",
  PATH: "/fake/bin",
  ...extra,
});

const build = (env: NodeJS.ProcessEnv, mainPath?: string) => {
  captures.child.length = 0;
  captures.docker.length = 0;
  captures.engine.length = 0;
  const logger = createSilentLogger();
  const launcher = createMeetingRunnerLauncher({ config: getControllerConfig(env), env, logger, mainPath });
  return { launcher, logger };
};

const withArgv = <T>(argv: string[], run: () => T): T => {
  const original = process.argv;
  process.argv = argv;
  try {
    return run();
  } finally {
    process.argv = original;
  }
};

describe("resolveRunnerMainPath", () => {
  it("swaps the file name and keeps the extension", () => {
    expect(resolveRunnerMainPath("/srv/bot/src/main.ts")).toBe("/srv/bot/src/runnerMain.ts");
    expect(resolveRunnerMainPath("/srv/bot/dist/main.js")).toBe("/srv/bot/dist/runnerMain.js");
    expect(resolveRunnerMainPath("/srv/bot/dist/main.mjs")).toBe("/srv/bot/dist/runnerMain.mjs");
    expect(resolveRunnerMainPath("/srv/bot/dist/main.cjs")).toBe("/srv/bot/dist/runnerMain.cjs");
  });

  it("makes a relative path absolute", () => {
    const resolved = resolveRunnerMainPath("dist/main.js");
    expect(resolved.startsWith("/")).toBe(true);
    expect(resolved.endsWith("/dist/runnerMain.js")).toBe(true);
  });

  it("handles a path without an extension", () => {
    expect(resolveRunnerMainPath("/srv/bot/main")).toBe("/srv/bot/runnerMain");
  });
});

describe("createMeetingRunnerLauncher with the child process launcher", () => {
  it("spawns the runner entry file next to the main file with the loader flags of this process", () => {
    const { launcher, logger } = build({ NOTETAKER_BOT_SECRET: "test-secret-not-real" }, MAIN_PATH);

    expect(captures.child).toHaveLength(1);
    expect(captures.child[0]?.command).toBe(process.execPath);
    expect(captures.child[0]?.args).toEqual([...process.execArgv, RUNNER_PATH]);
    expect(captures.child[0]?.logger).toBe(logger);
    expect(launcher).toBeInstanceOf(ChildProcessMeetingRunnerLauncher);
    expect(captures.docker).toHaveLength(0);
    expect(captures.engine).toHaveLength(0);
  });

  it("passes only the allowlisted variables plus PATH, HOME and DISPLAY", () => {
    const env = buildFullEnv();
    build(env, MAIN_PATH);

    expect(captures.child[0]?.env).toEqual({
      ...pickRunnerEnv(env),
      PATH: "/fake/bin",
      HOME: "/fake/home",
      DISPLAY: ":99",
    });
    const keys = Object.keys(captures.child[0]?.env ?? {});
    for (const forbidden of [
      "NOTETAKER_BOT_PORT",
      "NOTETAKER_BOT_CAPACITY",
      "NOTETAKER_BOT_LAUNCHER",
      "NOTETAKER_RUNNER_IMAGE",
      "NOTETAKER_DOCKER_SOCKET",
      "NOTETAKER_RUNNER_JOIN_REQUEST",
      "UNRELATED_TOKEN",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("omits PATH, HOME and DISPLAY when they are unset or empty", () => {
    build({ NOTETAKER_BOT_SECRET: "test-secret-not-real", PATH: "", HOME: undefined }, MAIN_PATH);

    const env = captures.child[0]?.env ?? {};
    expect(Object.keys(env)).not.toContain("PATH");
    expect(Object.keys(env)).not.toContain("HOME");
    expect(Object.keys(env)).not.toContain("DISPLAY");
    expect(Object.values(env)).not.toContain(undefined);
    expect(Object.values(env)).not.toContain("undefined");
  });

  it("defaults the main path to the script this process was started with", () => {
    const script = process.argv[1];
    if (typeof script !== "string") throw new Error("the test runner has no script path");

    build({ NOTETAKER_BOT_SECRET: "test-secret-not-real" });

    expect(captures.child[0]?.args.at(-1)).toBe(resolveRunnerMainPath(script));
  });

  it("throws when there is no main path at all", () => {
    withArgv(["node"], () => {
      expect(() => build({ NOTETAKER_BOT_SECRET: "test-secret-not-real" })).toThrow(/runner entry file/);
    });

    expect(captures.child).toHaveLength(0);
  });
});

describe("createMeetingRunnerLauncher with the docker launcher", () => {
  it("builds an engine client and a launcher with the runner allowlist only", () => {
    const env = dockerEnv({ NOTETAKER_DOCKER_NETWORK: "bots", HOME: "/fake/home", DISPLAY: ":99" });
    const { launcher, logger } = build(env, MAIN_PATH);

    expect(captures.engine).toEqual([{ socketPath: "/tmp/fake-docker.sock" }]);
    expect(captures.docker).toHaveLength(1);
    const deps = captures.docker[0];
    expect(deps?.image).toBe("notetaker-runner:test");
    expect(deps?.capacity).toBe(3);
    expect(deps?.networkMode).toBe("bots");
    expect(deps?.logger).toBe(logger);
    expect(deps?.env).toEqual(pickRunnerEnv(env));
    expect(Object.keys(deps?.env ?? {})).not.toContain("PATH");
    expect(launcher).toBeInstanceOf(DockerMeetingRunnerLauncher);
    expect(captures.child).toHaveLength(0);
  });

  it("does not depend on the script path", () => {
    withArgv(["node"], () => {
      build(dockerEnv());
    });

    expect(captures.docker).toHaveLength(1);
  });

  it("passes no network when none is configured", () => {
    build(dockerEnv(), MAIN_PATH);

    expect(captures.docker[0]?.networkMode).toBeNull();
  });

  it("refuses a docker config without a docker section", () => {
    const env = dockerEnv();
    const config = { ...getControllerConfig(env), docker: null };

    expect(() =>
      createMeetingRunnerLauncher({ config, env, logger: createSilentLogger(), mainPath: MAIN_PATH })
    ).toThrow(/NOTETAKER_RUNNER_IMAGE/);
  });
});
