// @vitest-environment node
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { describe, expect, it, vi } from "vitest";
import { buildJoinRequest } from "../../testing/httpTestKit";
import { InProcessMeetingRunnerLauncher } from "./InProcessMeetingRunnerLauncher";
import type { RunnerHandle, RunnerStatus } from "./MeetingRunnerLauncher";
import { RunnerLaunchError } from "./MeetingRunnerLauncher";

class FakeRunnerHandle implements RunnerHandle {
  startCalls = 0;
  stopCalls = 0;
  status: RunnerStatus = { phase: "STARTING", lastEventSequence: 0 };
  startError: Error | null = null;
  readonly done: Promise<unknown>;
  private resolveDone: () => void = () => undefined;
  private rejectDone: (error: Error) => void = () => undefined;

  constructor() {
    this.done = new Promise<unknown>((resolve, reject) => {
      this.resolveDone = () => resolve(undefined);
      this.rejectDone = reject;
    });
  }

  start(): void {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
  }

  requestStop(): void {
    this.stopCalls += 1;
  }

  getStatus(): RunnerStatus {
    return this.status;
  }

  finish(): void {
    this.resolveDone();
  }

  fail(error: Error): void {
    this.rejectDone(error);
  }
}

function createHarness() {
  const handles: FakeRunnerHandle[] = [];
  const requests: NotetakerBotJoinRequest[] = [];
  const createRunner = vi.fn((request: NotetakerBotJoinRequest): RunnerHandle => {
    requests.push(request);
    const handle = new FakeRunnerHandle();
    handles.push(handle);
    return handle;
  });
  const launcher = new InProcessMeetingRunnerLauncher({ createRunner });
  return { launcher, createRunner, handles, requests };
}

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("InProcessMeetingRunnerLauncher", () => {
  it("creates one runner from the request, starts it and returns an in-process ref", async () => {
    const { launcher, createRunner, handles, requests } = createHarness();
    const request = buildJoinRequest({ sessionId: SESSION_A });

    const result = await launcher.launch(request);

    expect(result).toEqual({ externalRef: `in-process-${SESSION_A}` });
    expect(createRunner).toHaveBeenCalledTimes(1);
    expect(requests[0]).toBe(request);
    expect(handles[0]?.startCalls).toBe(1);
  });

  it("returns the same ref on a repeated launch without creating or starting anything", async () => {
    const { launcher, createRunner, handles } = createHarness();
    const request = buildJoinRequest({ sessionId: SESSION_A });

    const first = await launcher.launch(request);
    const second = await launcher.launch(request);

    expect(second).toEqual(first);
    expect(createRunner).toHaveBeenCalledTimes(1);
    expect(handles[0]?.startCalls).toBe(1);
  });

  it("creates nothing on a repeated launch after the runner ended", async () => {
    const { launcher, createRunner, handles } = createHarness();
    const request = buildJoinRequest({ sessionId: SESSION_A });
    const first = await launcher.launch(request);
    handles[0]?.finish();
    await flushMicrotasks();

    const second = await launcher.launch(request);

    expect(second).toEqual(first);
    expect(createRunner).toHaveBeenCalledTimes(1);
  });

  it("throws a FAILED launch error and forgets the session when createRunner throws", async () => {
    const createRunner = vi.fn((): RunnerHandle => {
      throw new Error("boom");
    });
    const launcher = new InProcessMeetingRunnerLauncher({ createRunner });

    const error = await launcher.launch(buildJoinRequest({ sessionId: SESSION_A })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunnerLaunchError);
    expect(error instanceof RunnerLaunchError && error.kind).toBe("FAILED");
    expect(await launcher.getStatus(SESSION_A)).toBeNull();
    expect(await launcher.countActive()).toBe(0);
  });

  it("throws a FAILED launch error and forgets the session when start throws", async () => {
    const handle = new FakeRunnerHandle();
    handle.startError = new Error("cannot start");
    const launcher = new InProcessMeetingRunnerLauncher({ createRunner: () => handle });

    const error = await launcher.launch(buildJoinRequest({ sessionId: SESSION_A })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunnerLaunchError);
    expect(error instanceof RunnerLaunchError && error.kind).toBe("FAILED");
    expect(await launcher.getStatus(SESSION_A)).toBeNull();
    expect(await launcher.countActive()).toBe(0);
  });

  it("passes the live handle status through as a copy and returns null for an unknown session", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));
    const handle = handles[0];
    if (!handle) throw new Error("expected a handle");
    handle.status = { phase: "WAITING", lastEventSequence: 3 };

    const status = await launcher.getStatus(SESSION_A);

    expect(status).toEqual({ phase: "WAITING", lastEventSequence: 3 });
    expect(status).not.toBe(handle.status);
    expect(await launcher.getStatus(SESSION_B)).toBeNull();
  });

  it("reports ENDED once done settled even when the handle still says IN_MEETING", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));
    const handle = handles[0];
    if (!handle) throw new Error("expected a handle");
    handle.status = { phase: "IN_MEETING", lastEventSequence: 7 };
    handle.finish();
    await flushMicrotasks();

    expect(await launcher.getStatus(SESSION_A)).toEqual({ phase: "ENDED", lastEventSequence: 7 });
  });

  it("marks the runner ended when done rejects without an unhandled rejection", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));
    const handle = handles[0];
    if (!handle) throw new Error("expected a handle");
    handle.status = { phase: "IN_MEETING", lastEventSequence: 2 };
    handle.fail(new Error("runner crashed"));
    await flushMicrotasks();

    expect(await launcher.getStatus(SESSION_A)).toEqual({ phase: "ENDED", lastEventSequence: 2 });
    expect(await launcher.countActive()).toBe(0);
  });

  it("counts only runners that are neither ENDED nor settled", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_B }));
    const third = "00000000-0000-4000-8000-00000000000c";
    await launcher.launch(buildJoinRequest({ sessionId: third }));
    expect(await launcher.countActive()).toBe(3);

    const [first, second] = handles;
    if (!first || !second) throw new Error("expected handles");
    first.status = { phase: "ENDED", lastEventSequence: 1 };
    second.finish();
    await flushMicrotasks();

    expect(await launcher.countActive()).toBe(1);
  });

  it("requests a stop once and resolves while done is still pending", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));

    await launcher.stop(SESSION_A);

    expect(handles[0]?.stopCalls).toBe(1);
  });

  it("resolves a stop for an unknown or ended session without calling anything", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));
    handles[0]?.finish();
    await flushMicrotasks();

    await expect(launcher.stop(SESSION_A)).resolves.toBeUndefined();
    await expect(launcher.stop(SESSION_B)).resolves.toBeUndefined();

    expect(handles[0]?.stopCalls).toBe(0);
  });

  it("requests a stop on every active runner and resolves only after every done settled", async () => {
    const { launcher, handles } = createHarness();
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_A }));
    await launcher.launch(buildJoinRequest({ sessionId: SESSION_B }));
    const [first, second] = handles;
    if (!first || !second) throw new Error("expected handles");
    let resolved = false;

    const shutdown = launcher.shutdown().then(() => {
      resolved = true;
    });
    await flushMicrotasks();

    expect(first.stopCalls).toBe(1);
    expect(second.stopCalls).toBe(1);
    expect(resolved).toBe(false);

    first.finish();
    await flushMicrotasks();
    expect(resolved).toBe(false);

    second.finish();
    await shutdown;
    expect(resolved).toBe(true);
  });

  it("resolves a shutdown with nothing launched", async () => {
    const { launcher } = createHarness();

    await expect(launcher.shutdown()).resolves.toBeUndefined();
  });
});
