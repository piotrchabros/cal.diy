// @vitest-environment node
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../logger";
import { buildJoinRequest } from "../../testing/httpTestKit";
import type { DockerContainerSpec, IDockerEngine } from "./DockerEngineClient";
import { DockerMeetingRunnerLauncher, RUNNER_SESSION_LABEL } from "./DockerMeetingRunnerLauncher";
import { RunnerLaunchError } from "./MeetingRunnerLauncher";
import {
  decodeJoinRequestEnv,
  encodeJoinRequestEnv,
  encodeRunnerStatus,
  RUNNER_JOIN_REQUEST_ENV,
} from "./runnerStatusProtocol";

const SECRET = "test-secret-not-real";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const NAME = `notetaker-${SESSION_ID}`;
const GRACE_SECONDS = 15;

type Operation = "inspect" | "list" | "create" | "start" | "logs" | "stop" | "remove";

type FakeContainer = { id: string; running: boolean; labelSession: string; logs: string };

class FakeDockerEngine implements IDockerEngine {
  readonly calls: string[] = [];
  readonly createdSpecs: DockerContainerSpec[] = [];
  readonly containers = new Map<string, FakeContainer>();
  failOn: Partial<Record<Operation, Error>> = {};
  failStopOnId: string | null = null;
  createAlreadyExists = false;
  removeOnStop = false;
  private nextId = 1;

  add(name: string, options: { running: boolean; logs?: string; labelSession?: string }): string {
    const id = `container-${this.nextId++}`;
    this.containers.set(name, {
      id,
      running: options.running,
      labelSession: options.labelSession ?? name,
      logs: options.logs ?? "",
    });
    return id;
  }

  idOf(name: string): string {
    const container = this.containers.get(name);
    if (!container) throw new Error(`no fake container named ${name}`);
    return container.id;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async createContainer(spec: DockerContainerSpec): Promise<{ id: string; alreadyExists: boolean }> {
    this.calls.push("create");
    this.throwIfFailing("create");
    this.createdSpecs.push(spec);
    if (this.createAlreadyExists) return { id: "pre-existing-id", alreadyExists: true };
    const id = this.add(spec.name, { running: false, labelSession: spec.labels[RUNNER_SESSION_LABEL] });
    return { id, alreadyExists: false };
  }

  async startContainer(id: string): Promise<void> {
    this.calls.push(`start:${id}`);
    this.throwIfFailing("start");
    const found = this.find(id);
    if (found) found.container.running = true;
  }

  async inspectContainer(idOrName: string): Promise<{ id: string; running: boolean } | null> {
    this.calls.push(`inspect:${idOrName}`);
    this.throwIfFailing("inspect");
    const found = this.find(idOrName);
    return found ? { id: found.container.id, running: found.container.running } : null;
  }

  async listContainers(label: string): Promise<{ id: string; name: string; running: boolean }[]> {
    this.calls.push(`list:${label}`);
    this.throwIfFailing("list");
    return [...this.containers.entries()].map(([name, container]) => ({
      id: container.id,
      name,
      running: container.running,
    }));
  }

  async readLogTail(id: string, lines: number): Promise<string> {
    this.calls.push(`logs:${id}:${lines}`);
    this.throwIfFailing("logs");
    return this.find(id)?.container.logs ?? "";
  }

  async stopContainer(id: string, graceSeconds: number): Promise<void> {
    this.calls.push(`stop:${id}:${graceSeconds}`);
    this.throwIfFailing("stop");
    if (this.failStopOnId === id) throw new Error("stop failed for this container");
    const found = this.find(id);
    if (!found) return;
    found.container.running = false;
    if (this.removeOnStop) this.containers.delete(found.name);
  }

  async removeContainer(id: string): Promise<void> {
    this.calls.push(`remove:${id}`);
    this.throwIfFailing("remove");
    const found = this.find(id);
    if (found) this.containers.delete(found.name);
  }

  private find(idOrName: string): { name: string; container: FakeContainer } | null {
    const byName = this.containers.get(idOrName);
    if (byName) return { name: idOrName, container: byName };
    for (const [name, container] of this.containers) {
      if (container.id === idOrName) return { name, container };
    }
    return null;
  }

  private throwIfFailing(operation: Operation): void {
    const error = this.failOn[operation];
    if (error) throw error;
  }
}

function firstCreatedSpec(engine: FakeDockerEngine): DockerContainerSpec {
  const spec = engine.createdSpecs[0];
  if (!spec) throw new Error("expected the engine to have created a container spec, but none was created");
  return spec;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function statusLine(phase: "WAITING" | "IN_MEETING" | "ENDED", lastEventSequence: number): string {
  return encodeRunnerStatus({ phase, lastEventSequence });
}

describe("DockerMeetingRunnerLauncher", () => {
  let engine: FakeDockerEngine;
  let logLines: string[];
  let launcher: DockerMeetingRunnerLauncher;

  function createLauncher(
    overrides: Partial<ConstructorParameters<typeof DockerMeetingRunnerLauncher>[0]> = {}
  ): DockerMeetingRunnerLauncher {
    return new DockerMeetingRunnerLauncher({
      engine,
      image: "runner:test",
      env: { NOTETAKER_BOT_SECRET: SECRET, TZ: "UTC" },
      capacity: 2,
      networkMode: null,
      logger: createLogger({ level: "debug", write: (line) => logLines.push(line) }),
      ...overrides,
    });
  }

  beforeEach(() => {
    engine = new FakeDockerEngine();
    logLines = [];
    launcher = createLauncher();
  });

  describe("launch", () => {
    it("creates and starts one container and returns its id", async () => {
      const request = buildJoinRequest();

      const result = await launcher.launch(request);

      const id = engine.idOf(NAME);
      expect(result).toEqual({ externalRef: id });
      expect(engine.calls).toEqual([
        `inspect:${NAME}`,
        `list:${RUNNER_SESSION_LABEL}`,
        "create",
        `start:${id}`,
      ]);
    });

    it("builds the container spec with the join request in the environment", async () => {
      const request = buildJoinRequest();

      await launcher.launch(request);

      expect(engine.createdSpecs[0]).toEqual({
        name: NAME,
        image: "runner:test",
        env: [
          `NOTETAKER_BOT_SECRET=${SECRET}`,
          "TZ=UTC",
          `${RUNNER_JOIN_REQUEST_ENV}=${encodeJoinRequestEnv(request)}`,
        ],
        labels: { [RUNNER_SESSION_LABEL]: SESSION_ID },
        shmSizeBytes: 1073741824,
        networkMode: null,
      });
      expect(Object.keys(firstCreatedSpec(engine)).sort()).toEqual([
        "env",
        "image",
        "labels",
        "name",
        "networkMode",
        "shmSizeBytes",
      ]);
      const joinEntry = firstCreatedSpec(engine).env.find((entry) =>
        entry.startsWith(`${RUNNER_JOIN_REQUEST_ENV}=`)
      );
      expect(decodeJoinRequestEnv(joinEntry?.slice(RUNNER_JOIN_REQUEST_ENV.length + 1))).toEqual(request);
    });

    it("labels containers with the documented session label", () => {
      expect(RUNNER_SESSION_LABEL).toBe("com.cal.notetaker.session");
    });

    it("sanitises the container name but keeps the raw session id in the label", async () => {
      const rawSessionId = "a/b c:d+é";

      await launcher.launch(buildJoinRequest({ sessionId: rawSessionId }));

      expect(firstCreatedSpec(engine).name).toBe("notetaker-a_b_c_d__");
      expect(firstCreatedSpec(engine).labels).toEqual({ [RUNNER_SESSION_LABEL]: rawSessionId });
    });

    it("passes the network mode through when set", async () => {
      launcher = createLauncher({ networkMode: "notetaker-net" });

      await launcher.launch(buildJoinRequest());

      expect(firstCreatedSpec(engine).networkMode).toBe("notetaker-net");
    });

    it("replaces a join request variable from the configured environment instead of duplicating it", async () => {
      launcher = createLauncher({
        env: { [RUNNER_JOIN_REQUEST_ENV]: "stale-value-not-real", TZ: "UTC" },
      });
      const request = buildJoinRequest();

      await launcher.launch(request);

      const env = firstCreatedSpec(engine).env;
      expect(env).toEqual(["TZ=UTC", `${RUNNER_JOIN_REQUEST_ENV}=${encodeJoinRequestEnv(request)}`]);
      expect(env.filter((entry) => entry.startsWith(`${RUNNER_JOIN_REQUEST_ENV}=`))).toHaveLength(1);
    });

    it("returns the existing id of a running session without creating anything", async () => {
      const id = engine.add(NAME, { running: true });

      const result = await launcher.launch(buildJoinRequest());

      expect(result).toEqual({ externalRef: id });
      expect(engine.calls).toEqual([`inspect:${NAME}`]);
    });

    it("is idempotent for a running session even at capacity", async () => {
      launcher = createLauncher({ capacity: 1 });
      const id = engine.add(NAME, { running: true });

      const result = await launcher.launch(buildJoinRequest());

      expect(result).toEqual({ externalRef: id });
      expect(engine.calls).not.toContain("create");
    });

    it("returns an existing container that is not running without starting it", async () => {
      const id = engine.add(NAME, { running: false });

      const result = await launcher.launch(buildJoinRequest());

      expect(result).toEqual({ externalRef: id });
      expect(engine.calls).toEqual([`inspect:${NAME}`]);
    });

    it("rejects with AT_CAPACITY when running containers fill the capacity", async () => {
      engine.add("notetaker-other-1", { running: true });
      engine.add("notetaker-other-2", { running: true });

      const error = await rejection(launcher.launch(buildJoinRequest()));

      expect(error).toBeInstanceOf(RunnerLaunchError);
      expect(error).toMatchObject({ kind: "AT_CAPACITY" });
      expect(engine.calls).not.toContain("create");
    });

    it("counts only running containers against the capacity", async () => {
      engine.add("notetaker-other-1", { running: true });
      engine.add("notetaker-other-2", { running: false });

      const result = await launcher.launch(buildJoinRequest());

      expect(result.externalRef).toBe(engine.idOf(NAME));
    });

    it("returns the id of a container that create reports as already existing, without starting it", async () => {
      engine.createAlreadyExists = true;

      const result = await launcher.launch(buildJoinRequest());

      expect(result).toEqual({ externalRef: "pre-existing-id" });
      expect(engine.calls.some((call) => call.startsWith("start:"))).toBe(false);
    });

    it("removes the created container and fails when start fails", async () => {
      engine.failOn.start = new Error("start exploded");

      const error = await rejection(launcher.launch(buildJoinRequest()));

      expect(error).toBeInstanceOf(RunnerLaunchError);
      expect(error).toMatchObject({ kind: "FAILED" });
      expect(engine.calls).toContain("remove:container-1");
    });

    it("still fails with FAILED when the cleanup removal also fails", async () => {
      engine.failOn.start = new Error("start exploded");
      engine.failOn.remove = new Error("remove exploded");

      const error = await rejection(launcher.launch(buildJoinRequest()));

      expect(error).toBeInstanceOf(RunnerLaunchError);
      expect(error).toMatchObject({ kind: "FAILED" });
      expect(engine.calls).toContain("remove:container-1");
    });

    it.each([
      ["inspect"],
      ["list"],
      ["create"],
    ] as const)("fails with FAILED naming the step and session when %s fails", async (step) => {
      const underlyingMessage = `engine-${step}-detail-not-real`;
      engine.failOn[step] = new Error(underlyingMessage);

      const error = await rejection(launcher.launch(buildJoinRequest()));

      expect(error).toBeInstanceOf(RunnerLaunchError);
      if (!(error instanceof RunnerLaunchError)) return;
      expect(error.kind).toBe("FAILED");
      expect(error.message).toContain(step);
      expect(error.message).toContain(SESSION_ID);
      expect(error.message).not.toContain(underlyingMessage);
    });
  });

  describe("getStatus", () => {
    it("returns null when there is no container", async () => {
      expect(await launcher.getStatus(SESSION_ID)).toBeNull();
    });

    it("reports STARTING for a running container without a status line", async () => {
      const id = engine.add(NAME, { running: true, logs: "booting\n" });

      const status = await launcher.getStatus(SESSION_ID);

      expect(status).toEqual({ phase: "STARTING", lastEventSequence: 0 });
      expect(engine.calls).toContain(`logs:${id}:50`);
    });

    it("returns the last status line of the log tail", async () => {
      const logs = [
        "booting",
        statusLine("WAITING", 1),
        "some other output",
        statusLine("IN_MEETING", 7),
        "trailing output",
        "",
      ].join("\r\n");
      engine.add(NAME, { running: true, logs });

      const status = await launcher.getStatus(SESSION_ID);

      expect(status).toEqual({ phase: "IN_MEETING", lastEventSequence: 7 });
    });

    it("reports ENDED with the last logged sequence for a container that is not running", async () => {
      engine.add(NAME, {
        running: false,
        logs: `${statusLine("IN_MEETING", 4)}\n${statusLine("ENDED", 9)}\n`,
      });

      const status = await launcher.getStatus(SESSION_ID);

      expect(status).toEqual({ phase: "ENDED", lastEventSequence: 9 });
    });

    it("reports ENDED with sequence 0 when a stopped container has no status line", async () => {
      engine.add(NAME, { running: false, logs: "nothing useful\n" });

      expect(await launcher.getStatus(SESSION_ID)).toEqual({ phase: "ENDED", lastEventSequence: 0 });
    });

    it("reports ENDED with sequence 0 when reading the logs of a stopped container fails", async () => {
      engine.add(NAME, { running: false, logs: statusLine("ENDED", 9) });
      engine.failOn.logs = new Error("logs unavailable");

      expect(await launcher.getStatus(SESSION_ID)).toEqual({ phase: "ENDED", lastEventSequence: 0 });
    });

    it("propagates a log read failure for a running container", async () => {
      engine.add(NAME, { running: true });
      engine.failOn.logs = new Error("logs unavailable");

      await expect(launcher.getStatus(SESSION_ID)).rejects.toThrow("logs unavailable");
    });
  });

  describe("countActive", () => {
    it("counts running containers by session label", async () => {
      engine.add("notetaker-a", { running: true });
      engine.add("notetaker-b", { running: false });
      engine.add("notetaker-c", { running: true });

      expect(await launcher.countActive()).toBe(2);
      expect(engine.calls).toEqual([`list:${RUNNER_SESSION_LABEL}`]);
    });

    it("rejects when the list fails", async () => {
      engine.failOn.list = new Error("list unavailable");

      await expect(launcher.countActive()).rejects.toThrow("list unavailable");
    });
  });

  describe("stop", () => {
    it("stops with the grace period, then removes the container that still exists", async () => {
      const id = engine.add(NAME, { running: true });

      await launcher.stop(SESSION_ID);

      expect(engine.calls).toEqual([
        `inspect:${NAME}`,
        `stop:${id}:${GRACE_SECONDS}`,
        `inspect:${id}`,
        `remove:${id}`,
      ]);
    });

    it("does not remove a container that auto-removal already took", async () => {
      const id = engine.add(NAME, { running: true });
      engine.removeOnStop = true;

      await launcher.stop(SESSION_ID);

      expect(engine.calls).toEqual([`inspect:${NAME}`, `stop:${id}:${GRACE_SECONDS}`, `inspect:${id}`]);
    });

    it("resolves after a single inspect for an unknown session", async () => {
      await expect(launcher.stop(SESSION_ID)).resolves.toBeUndefined();

      expect(engine.calls).toEqual([`inspect:${NAME}`]);
    });

    it("skips the stop for a container that is not running and removes it", async () => {
      const id = engine.add(NAME, { running: false });

      await launcher.stop(SESSION_ID);

      expect(engine.calls.some((call) => call.startsWith("stop:"))).toBe(false);
      expect(engine.calls).toContain(`remove:${id}`);
    });

    it("rejects when stopping the container fails", async () => {
      engine.add(NAME, { running: true });
      engine.failOn.stop = new Error("stop unavailable");

      await expect(launcher.stop(SESSION_ID)).rejects.toThrow("stop unavailable");
    });

    it("resolves when only the removal fails", async () => {
      engine.add(NAME, { running: true });
      engine.failOn.remove = new Error("remove unavailable");

      await expect(launcher.stop(SESSION_ID)).resolves.toBeUndefined();
    });
  });

  describe("shutdown", () => {
    it("stops every running container and skips the ones that are not running", async () => {
      const runningA = engine.add("notetaker-a", { running: true });
      const runningB = engine.add("notetaker-b", { running: true });
      const exited = engine.add("notetaker-c", { running: false });

      await launcher.shutdown();

      expect(engine.calls).toContain(`stop:${runningA}:${GRACE_SECONDS}`);
      expect(engine.calls).toContain(`stop:${runningB}:${GRACE_SECONDS}`);
      expect(engine.calls.some((call) => call.startsWith(`stop:${exited}`))).toBe(false);
    });

    it("never rejects when one stop fails and still stops the others", async () => {
      const failing = engine.add("notetaker-a", { running: true });
      const healthy = engine.add("notetaker-b", { running: true });
      engine.failStopOnId = failing;

      await expect(launcher.shutdown()).resolves.toBeUndefined();

      expect(engine.calls).toContain(`stop:${healthy}:${GRACE_SECONDS}`);
    });

    it("resolves when the list fails", async () => {
      engine.failOn.list = new Error("list unavailable");

      await expect(launcher.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("state", () => {
    it("keeps no state of its own, so a second launcher sees the first one's session", async () => {
      const request = buildJoinRequest();
      const { externalRef } = await launcher.launch(request);
      const second = createLauncher();

      expect(await second.getStatus(SESSION_ID)).toEqual({ phase: "STARTING", lastEventSequence: 0 });
      expect(await second.countActive()).toBe(1);
      expect(await second.launch(request)).toEqual({ externalRef });
      expect(engine.createdSpecs).toHaveLength(1);
    });
  });

  describe("logging", () => {
    function expectNoSensitiveContent(request: NotetakerBotJoinRequest): void {
      const output = logLines.join("\n");
      expect(output).not.toBe("");
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain(encodeJoinRequestEnv(request));
      expect(output).not.toContain(request.meetingUrl);
      expect(output).not.toContain(request.callbackUrl);
      expect(output).not.toContain(request.noticeMessage);
      expect(output).not.toContain(request.displayName);
    }

    it("does not log env values or join request content after a successful launch", async () => {
      const request = buildJoinRequest({ sessionId: OTHER_SESSION_ID });

      await launcher.launch(request);

      expectNoSensitiveContent(request);
    });

    it("does not log env values, join request content or the engine message after a failed launch", async () => {
      const request = buildJoinRequest();
      engine.failOn.create = new Error(`create rejected ${SECRET} ${encodeJoinRequestEnv(request)}`);

      await rejection(launcher.launch(request));

      expectNoSensitiveContent(request);
    });
  });
});
