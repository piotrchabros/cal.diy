// @vitest-environment node
import { ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { PassThrough } from "node:stream";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../logger";
import { buildJoinRequest } from "../../testing/httpTestKit";
import { ChildProcessMeetingRunnerLauncher } from "./ChildProcessMeetingRunnerLauncher";
import type { RunnerStatus } from "./MeetingRunnerLauncher";
import { RunnerLaunchError } from "./MeetingRunnerLauncher";
import {
  decodeJoinRequestEnv,
  encodeJoinRequestEnv,
  encodeRunnerStatus,
  RUNNER_JOIN_REQUEST_ENV,
} from "./runnerStatusProtocol";

// Overloaded `spawn` cannot be faked with a plain function without a cast, so the module export is a
// call-through mock that individual tests replace with a FakeChild.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

class FakeChild extends ChildProcess {
  override readonly pid: number | undefined;
  override stdout = new PassThrough();
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];
  killResult = true;
  killError: Error | undefined = undefined;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (signal === "SIGKILL" && this.killError) throw this.killError;
    return this.killResult;
  }
}

type LauncherDeps = ConstructorParameters<typeof ChildProcessMeetingRunnerLauncher>[0];

const SECRET = "test-secret-not-real";
const DEPS_ENV = { NOTETAKER_BOT_SECRET: SECRET, TZ: "UTC" };
const GRACE_MS = 40;

let lines: string[] = [];
let realLauncher: ChildProcessMeetingRunnerLauncher | undefined;

const createLauncher = (overrides: Partial<LauncherDeps> = {}): ChildProcessMeetingRunnerLauncher =>
  new ChildProcessMeetingRunnerLauncher({
    command: "runner-bin",
    args: ["--flag"],
    env: DEPS_ENV,
    logger: createLogger({
      level: "debug",
      write: (line) => {
        lines.push(line);
      },
    }),
    spawnFn: spawn,
    stopGraceMs: GRACE_MS,
    ...overrides,
  });

const fakeSpawnReturning = (...children: FakeChild[]): void => {
  const mocked = vi.mocked(spawn);
  for (const child of children) {
    mocked.mockImplementationOnce(() => child);
  }
};

const settle = (ms = 20): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const statusLine = (status: RunnerStatus): string => `${encodeRunnerStatus(status)}\n`;

const expectStatus = async (
  launcher: ChildProcessMeetingRunnerLauncher,
  sessionId: string,
  expected: RunnerStatus | null
): Promise<void> => {
  await vi.waitFor(async () => {
    expect(await launcher.getStatus(sessionId)).toEqual(expected);
  });
};

const captureError = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error
  );

beforeEach(() => {
  lines = [];
  realLauncher = undefined;
});

afterEach(async () => {
  if (realLauncher) await realLauncher.shutdown();
  vi.mocked(spawn).mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChildProcessMeetingRunnerLauncher", () => {
  describe("launch", () => {
    it("spawns with the command, args, env plus the join request, and the stdio tuple", async () => {
      const request = buildJoinRequest();
      fakeSpawnReturning(new FakeChild(4242));

      await createLauncher().launch(request);

      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
      const call = vi.mocked(spawn).mock.calls[0];
      if (!call) throw new Error("spawn was not called");
      const [command, args, options] = call;
      expect(command).toBe("runner-bin");
      expect(args).toEqual(["--flag"]);
      expect(options?.stdio).toEqual(["ignore", "pipe", "inherit"]);
      expect(options?.env).toEqual({
        ...DEPS_ENV,
        [RUNNER_JOIN_REQUEST_ENV]: encodeJoinRequestEnv(request),
      });
      expect(decodeJoinRequestEnv(options?.env?.[RUNNER_JOIN_REQUEST_ENV])).toEqual(request);
    });

    it("returns pid-<pid> and reports STARTING before any status line", async () => {
      const request = buildJoinRequest();
      fakeSpawnReturning(new FakeChild(4242));
      const launcher = createLauncher();

      const handle = await launcher.launch(request);

      expect(handle).toEqual({ externalRef: "pid-4242" });
      expect(await launcher.getStatus(request.sessionId)).toEqual({
        phase: "STARTING",
        lastEventSequence: 0,
      });
    });

    it("reads the status from stdout lines", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      child.stdout.write(statusLine({ phase: "WAITING", lastEventSequence: 1 }));

      await expectStatus(launcher, request.sessionId, { phase: "WAITING", lastEventSequence: 1 });
    });

    it("joins a status line that is split across chunks", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);
      const line = statusLine({ phase: "IN_MEETING", lastEventSequence: 5 });
      const cut = Math.floor(line.length / 2);

      child.stdout.write(line.slice(0, cut));
      await settle();
      expect(await launcher.getStatus(request.sessionId)).toEqual({
        phase: "STARTING",
        lastEventSequence: 0,
      });

      child.stdout.write(line.slice(cut));

      await expectStatus(launcher, request.sessionId, { phase: "IN_MEETING", lastEventSequence: 5 });
    });

    it("handles several lines in one chunk, ignores other lines and keeps the last status", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      child.stdout.write(
        [
          "chromium started",
          encodeRunnerStatus({ phase: "WAITING", lastEventSequence: 1 }),
          "@@notetaker-status not-json",
          encodeRunnerStatus({ phase: "IN_MEETING", lastEventSequence: 3 }),
          "",
        ].join("\n")
      );

      await expectStatus(launcher, request.sessionId, { phase: "IN_MEETING", lastEventSequence: 3 });
    });

    it("applies a status line without a trailing newline when stdout ends", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      child.stdout.end(encodeRunnerStatus({ phase: "IN_MEETING", lastEventSequence: 4 }));

      await expectStatus(launcher, request.sessionId, { phase: "IN_MEETING", lastEventSequence: 4 });
    });

    it("spawns nothing for a repeated launch of a running session", async () => {
      const request = buildJoinRequest();
      fakeSpawnReturning(new FakeChild(77));
      const launcher = createLauncher();
      const first = await launcher.launch(request);

      const second = await launcher.launch(request);

      expect(second).toEqual(first);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    });

    it("spawns nothing for a repeated launch of an exited session", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(77);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      const first = await launcher.launch(request);
      child.emit("exit", 0, null);

      const second = await launcher.launch(request);

      expect(second).toEqual(first);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    });

    it("fails the launch when the child has no pid and forgets it", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(undefined);
      fakeSpawnReturning(child);
      const launcher = createLauncher();

      const error = await captureError(launcher.launch(request));

      expect(error).toBeInstanceOf(RunnerLaunchError);
      expect(error).toMatchObject({ kind: "FAILED" });
      expect(await launcher.getStatus(request.sessionId)).toBeNull();
      expect(await launcher.countActive()).toBe(0);
      expect(() =>
        child.emit("error", Object.assign(new Error("spawn runner-bin ENOENT"), { code: "ENOENT" }))
      ).not.toThrow();
    });

    it("fails the launch when spawn throws", async () => {
      const request = buildJoinRequest();
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw new Error("spawn exploded");
      });
      const launcher = createLauncher();

      const error = await captureError(launcher.launch(request));

      expect(error).toBeInstanceOf(RunnerLaunchError);
      expect(error).toMatchObject({ kind: "FAILED" });
      expect(await launcher.getStatus(request.sessionId)).toBeNull();
    });

    it("does not throw on an error event after a successful spawn", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      await createLauncher().launch(request);

      expect(() =>
        child.emit("error", Object.assign(new Error("late failure"), { code: "EPIPE" }))
      ).not.toThrow();
    });

    it("prunes ended sessions after 24 hours on the next launch", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const requestA = buildJoinRequest({ sessionId: "session-a" });
      const requestB = buildJoinRequest({ sessionId: "session-b" });
      const childA = new FakeChild(1);
      fakeSpawnReturning(childA, new FakeChild(2));
      const launcher = createLauncher();
      await launcher.launch(requestA);
      childA.emit("exit", 0, null);
      expect(await launcher.getStatus("session-a")).toEqual({ phase: "ENDED", lastEventSequence: 0 });

      vi.setSystemTime(new Date("2030-01-02T01:00:00.000Z"));
      await launcher.launch(requestB);

      expect(await launcher.getStatus("session-a")).toBeNull();
      expect(await launcher.getStatus("session-b")).toEqual({ phase: "STARTING", lastEventSequence: 0 });
    });

    it("logs neither the join request nor any env value", async () => {
      const request: NotetakerBotJoinRequest = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();

      await launcher.launch(request);
      child.emit("error", Object.assign(new Error(`failed with ${SECRET}`), { code: "EPIPE" }));
      child.emit("exit", 1, null);
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw new Error(`spawn failed with ${SECRET}`);
      });
      await captureError(launcher.launch(buildJoinRequest({ sessionId: "other-session" })));

      expect(lines.length).toBeGreaterThan(0);
      const forbidden = [
        request.meetingUrl,
        request.displayName,
        request.noticeMessage,
        request.callbackUrl,
        SECRET,
        encodeJoinRequestEnv(request),
      ];
      for (const line of lines) {
        for (const value of forbidden) {
          expect(line).not.toContain(value);
        }
      }
    });
  });

  describe("getStatus and countActive", () => {
    it("marks the session ENDED on exit and keeps the last sequence", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);
      child.stdout.write(statusLine({ phase: "IN_MEETING", lastEventSequence: 7 }));
      await expectStatus(launcher, request.sessionId, { phase: "IN_MEETING", lastEventSequence: 7 });

      child.emit("exit", 0, null);

      expect(await launcher.getStatus(request.sessionId)).toEqual({ phase: "ENDED", lastEventSequence: 7 });
    });

    it("does not revive the phase when a status line arrives after exit", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);
      child.emit("exit", 0, null);

      child.stdout.write(statusLine({ phase: "IN_MEETING", lastEventSequence: 9 }));
      await settle();

      expect(await launcher.getStatus(request.sessionId)).toMatchObject({ phase: "ENDED" });
    });

    it("returns null for an unknown session", async () => {
      expect(await createLauncher().getStatus("never-launched")).toBeNull();
    });

    it("counts only running children", async () => {
      const childA = new FakeChild(1);
      const childB = new FakeChild(2);
      fakeSpawnReturning(childA, childB);
      const launcher = createLauncher();
      await launcher.launch(buildJoinRequest({ sessionId: "session-a" }));
      await launcher.launch(buildJoinRequest({ sessionId: "session-b" }));
      expect(await launcher.countActive()).toBe(2);

      childA.emit("exit", 0, null);

      expect(await launcher.countActive()).toBe(1);
    });
  });

  describe("stop", () => {
    it("sends SIGTERM and resolves without waiting for the exit", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      await launcher.stop(request.sessionId);

      expect(child.killSignals).toEqual(["SIGTERM"]);
      child.emit("exit", 0, "SIGTERM");
    });

    it("sends SIGKILL once the grace has passed", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      await launcher.stop(request.sessionId);

      await vi.waitFor(() => {
        expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      });
    });

    it("logs a SIGKILL that throws after the grace and does not crash", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      child.killError = Object.assign(new Error(`kill failed with ${SECRET}`), { code: "EPERM" });
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      await launcher.stop(request.sessionId);

      await vi.waitFor(() => {
        expect(lines.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({
            level: "warn",
            message: "runner process could not be killed after the stop grace",
            sessionId: request.sessionId,
            errorCode: "EPERM",
          })
        );
      });
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      for (const line of lines) {
        expect(line).not.toContain(SECRET);
      }
      expect(await launcher.getStatus(request.sessionId)).not.toBeNull();
      child.emit("exit", 0, null);
    });

    it("cancels the SIGKILL when the child exits within the grace", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      await launcher.stop(request.sessionId);
      child.emit("exit", 0, "SIGTERM");
      await settle(120);

      expect(child.killSignals).toEqual(["SIGTERM"]);
    });

    it("sends nothing more on a second stop", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);

      await launcher.stop(request.sessionId);
      await launcher.stop(request.sessionId);

      expect(child.killSignals).toEqual(["SIGTERM"]);
      child.emit("exit", 0, "SIGTERM");
    });

    it("resolves and signals nothing for an unknown or exited session", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const launcher = createLauncher();
      await launcher.launch(request);
      child.emit("exit", 0, null);

      await launcher.stop("never-launched");
      await launcher.stop(request.sessionId);

      expect(child.killSignals).toEqual([]);
    });

    it("does not let the kill timer hold the process open", async () => {
      const request = buildJoinRequest();
      const child = new FakeChild(10);
      fakeSpawnReturning(child);
      const ODD_GRACE_MS = 4321;
      const launcher = createLauncher({ stopGraceMs: ODD_GRACE_MS });
      await launcher.launch(request);
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

      await launcher.stop(request.sessionId);

      const graceTimerIndex = timeoutSpy.mock.calls.findIndex((call) => call[1] === ODD_GRACE_MS);
      expect(graceTimerIndex).toBeGreaterThanOrEqual(0);
      const timer = timeoutSpy.mock.results[graceTimerIndex]?.value;
      if (typeof timer !== "object" || timer === null || !("hasRef" in timer)) {
        throw new Error("setTimeout did not return a timer object with hasRef");
      }
      if (typeof timer.hasRef !== "function") throw new Error("timer.hasRef is not a function");
      expect(timer.hasRef()).toBe(false);
      child.emit("exit", 0, "SIGTERM");
    });
  });

  describe("shutdown", () => {
    it("signals every running child and resolves once all have exited", async () => {
      const childA = new FakeChild(1);
      const childB = new FakeChild(2);
      fakeSpawnReturning(childA, childB);
      const launcher = createLauncher();
      await launcher.launch(buildJoinRequest({ sessionId: "session-a" }));
      await launcher.launch(buildJoinRequest({ sessionId: "session-b" }));
      let resolved = false;

      const shutdown = launcher.shutdown().then(() => {
        resolved = true;
      });
      await settle();

      expect(childA.killSignals).toEqual(["SIGTERM"]);
      expect(childB.killSignals).toEqual(["SIGTERM"]);
      expect(resolved).toBe(false);

      childA.emit("exit", 0, "SIGTERM");
      await settle();
      expect(resolved).toBe(false);

      childB.emit("exit", 0, "SIGTERM");
      await shutdown;
      expect(resolved).toBe(true);
    });

    it("resolves when there are no children", async () => {
      await expect(createLauncher().shutdown()).resolves.toBeUndefined();
    });
  });

  describe("with a real process", () => {
    it("reads two status lines from stdout and stops the child on SIGTERM", async () => {
      const request = buildJoinRequest();
      const line1 = encodeRunnerStatus({ phase: "WAITING", lastEventSequence: 1 });
      const line2 = encodeRunnerStatus({ phase: "IN_MEETING", lastEventSequence: 2 });
      const script = [
        `process.on("SIGTERM",()=>process.exit(0));`,
        `process.stdout.write(${JSON.stringify(`${line1}\n`)});`,
        `process.stdout.write(${JSON.stringify(`${line2}\n`)});`,
        "setInterval(()=>{},1000);",
      ].join("");
      const launcher = createLauncher({
        command: process.execPath,
        args: ["-e", script],
        env: {},
        stopGraceMs: 2000,
      });
      realLauncher = launcher;

      const handle = await launcher.launch(request);

      expect(handle.externalRef).toMatch(/^pid-\d+$/);
      await vi.waitFor(
        async () => {
          expect(await launcher.getStatus(request.sessionId)).toEqual({
            phase: "IN_MEETING",
            lastEventSequence: 2,
          });
        },
        { timeout: 10000 }
      );
      expect(await launcher.countActive()).toBe(1);

      await launcher.stop(request.sessionId);

      await vi.waitFor(
        async () => {
          expect(await launcher.getStatus(request.sessionId)).toEqual({
            phase: "ENDED",
            lastEventSequence: 2,
          });
        },
        { timeout: 10000 }
      );
      expect(await launcher.countActive()).toBe(0);
    }, 20000);
  });
});
