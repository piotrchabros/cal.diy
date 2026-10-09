import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import type { Logger } from "../../logger";
import type { MeetingRunnerLauncher, RunnerStatus } from "./MeetingRunnerLauncher";
import { RunnerLaunchError } from "./MeetingRunnerLauncher";
import { encodeJoinRequestEnv, parseRunnerStatusLine, RUNNER_JOIN_REQUEST_ENV } from "./runnerStatusProtocol";

const DEFAULT_STOP_GRACE_MS = 15000;
// A runner that never prints a newline must not grow the controller's memory without bound.
const MAX_LINE_BUFFER_CHARS = 65536;
const ENDED_RETENTION_MS = 86_400_000;

type Entry = {
  child: ChildProcess;
  externalRef: string;
  status: RunnerStatus;
  exited: boolean;
  endedAt: number | null;
  lineBuffer: string;
  stopRequested: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  exit: Promise<void>;
  resolveExit: () => void;
};

type ChildProcessMeetingRunnerLauncherDeps = {
  command: string;
  args: string[];
  env: Record<string, string>;
  logger: Logger;
  spawnFn?: typeof import("node:child_process").spawn;
  stopGraceMs?: number;
};

const readErrorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

const applyLine = (entry: Entry, line: string): void => {
  const status = parseRunnerStatusLine(line);
  if (!status) return;

  entry.status.lastEventSequence = Math.max(entry.status.lastEventSequence, status.lastEventSequence);
  // Output buffered in the pipe can arrive after the exit event and must not revive the session.
  entry.status.phase = entry.exited ? "ENDED" : status.phase;
};

const createEntry = (child: ChildProcess, pid: number): Entry => {
  let resolveExit = (): void => {};
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  return {
    child,
    externalRef: `pid-${pid}`,
    status: { phase: "STARTING", lastEventSequence: 0 },
    exited: false,
    endedAt: null,
    lineBuffer: "",
    stopRequested: false,
    killTimer: null,
    exit,
    resolveExit,
  };
};

const readStatusLines = (entry: Entry, stdout: Readable): void => {
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    const pieces = (entry.lineBuffer + chunk).split("\n");
    entry.lineBuffer = pieces.pop() ?? "";
    for (const line of pieces) {
      applyLine(entry, line);
    }
    if (entry.lineBuffer.length > MAX_LINE_BUFFER_CHARS) entry.lineBuffer = "";
  });
  stdout.on("end", () => {
    if (entry.lineBuffer !== "") applyLine(entry, entry.lineBuffer);
    entry.lineBuffer = "";
  });
  // A broken pipe only means no more status lines; the exit event settles the session.
  stdout.on("error", () => {});
};

export class ChildProcessMeetingRunnerLauncher implements MeetingRunnerLauncher {
  private readonly deps: ChildProcessMeetingRunnerLauncherDeps;
  private readonly spawnFn: typeof import("node:child_process").spawn;
  private readonly stopGraceMs: number;
  private readonly sessions = new Map<string, Entry>();

  constructor(deps: ChildProcessMeetingRunnerLauncherDeps) {
    this.deps = deps;
    this.spawnFn = deps.spawnFn ?? spawn;
    this.stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  async launch(request: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
    const { sessionId } = request;
    this.pruneEnded();

    // An exited session is returned as well: a session id never gets a second run.
    const known = this.sessions.get(sessionId);
    if (known) return { externalRef: known.externalRef };

    const child = this.spawnRunner(request);

    // Without a listener an asynchronous spawn failure (ENOENT) is rethrown and crashes the controller.
    child.on("error", (error: Error) => {
      this.deps.logger.error("runner process reported an error", {
        sessionId,
        errorCode: readErrorCode(error),
      });
    });

    const { pid } = child;
    if (pid === undefined) {
      throw new RunnerLaunchError(
        "FAILED",
        `Unable to start the runner process for session ${sessionId}: no process id`
      );
    }

    const entry = createEntry(child, pid);
    this.sessions.set(sessionId, entry);
    readStatusLines(entry, child.stdout);
    child.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      entry.exited = true;
      entry.endedAt = Date.now();
      entry.status.phase = "ENDED";
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = null;
      entry.resolveExit();
      this.deps.logger.info("runner process exited", { sessionId, exitCode, signal });
    });

    this.deps.logger.info("runner process started", { sessionId, pid });
    return { externalRef: entry.externalRef };
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    try {
      this.signalStop(sessionId, entry);
    } catch {
      throw new Error(`Unable to signal the runner process for session ${sessionId}`);
    }
  }

  async getStatus(sessionId: string): Promise<RunnerStatus | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return { phase: entry.status.phase, lastEventSequence: entry.status.lastEventSequence };
  }

  async countActive(): Promise<number> {
    let active = 0;
    for (const entry of this.sessions.values()) {
      if (!entry.exited) active += 1;
    }
    return active;
  }

  async shutdown(): Promise<void> {
    const exits: Promise<void>[] = [];
    for (const [sessionId, entry] of this.sessions) {
      exits.push(entry.exit);
      try {
        this.signalStop(sessionId, entry);
      } catch {
        this.deps.logger.warn("runner process could not be signalled during shutdown", { sessionId });
      }
    }
    await Promise.all(exits);
  }

  private pruneEnded(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessions) {
      if (entry.exited && entry.endedAt !== null && now - entry.endedAt > ENDED_RETENTION_MS) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private spawnRunner(request: NotetakerBotJoinRequest): ChildProcessByStdio<null, Readable, null> {
    try {
      return this.spawnFn(this.deps.command, this.deps.args, {
        // Written last so a same-named key in the configured env cannot replace the join request.
        env: { ...this.deps.env, [RUNNER_JOIN_REQUEST_ENV]: encodeJoinRequestEnv(request) },
        stdio: ["ignore", "pipe", "inherit"],
      });
    } catch {
      // The thrown message can carry the command line or env, so it is neither logged nor rethrown.
      this.deps.logger.error("runner process could not be started", { sessionId: request.sessionId });
      throw new RunnerLaunchError(
        "FAILED",
        `Unable to start the runner process for session ${request.sessionId}: spawn threw`
      );
    }
  }

  private signalStop(sessionId: string, entry: Entry): void {
    if (entry.exited || entry.stopRequested) return;

    entry.stopRequested = true;
    try {
      entry.child.kill("SIGTERM");
    } catch (error) {
      entry.stopRequested = false;
      throw error;
    }

    entry.killTimer = setTimeout(() => {
      if (entry.exited) return;
      try {
        entry.child.kill("SIGKILL");
      } catch (error) {
        // A throw inside a timer callback is an uncaught exception that would take down every running meeting.
        this.deps.logger.warn("runner process could not be killed after the stop grace", {
          sessionId,
          errorCode: readErrorCode(error),
        });
      }
    }, this.stopGraceMs);
    // The pending kill must not keep the controller alive once everything else has finished.
    entry.killTimer.unref();
  }
}
