import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import type { MeetingRunnerLauncher, RunnerHandle, RunnerStatus } from "./MeetingRunnerLauncher";
import { RunnerLaunchError } from "./MeetingRunnerLauncher";

type RunnerEntry = {
  handle: RunnerHandle;
  externalRef: string;
  settled: boolean;
  finished: Promise<void>;
};

function isActive(entry: RunnerEntry): boolean {
  return !entry.settled && entry.handle.getStatus().phase !== "ENDED";
}

export class InProcessMeetingRunnerLauncher implements MeetingRunnerLauncher {
  private readonly createRunner: (request: NotetakerBotJoinRequest) => RunnerHandle;
  private readonly runners = new Map<string, RunnerEntry>();

  constructor(deps: { createRunner: (request: NotetakerBotJoinRequest) => RunnerHandle }) {
    this.createRunner = deps.createRunner;
  }

  async launch(request: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
    const { sessionId } = request;
    const known = this.runners.get(sessionId);
    if (known) return { externalRef: known.externalRef };

    let handle: RunnerHandle;
    try {
      handle = this.createRunner(request);
    } catch {
      throw new RunnerLaunchError("FAILED", `Unable to create a runner for session ${sessionId}`);
    }

    const externalRef = `in-process-${sessionId}`;
    const entry: RunnerEntry = { handle, externalRef, settled: false, finished: Promise.resolve() };
    // The rejection handler is required: a rejected done must not surface as an unhandled rejection.
    const mark = (): void => {
      entry.settled = true;
    };
    entry.finished = handle.done.then(mark, mark);
    this.runners.set(sessionId, entry);

    try {
      handle.start();
    } catch {
      this.runners.delete(sessionId);
      throw new RunnerLaunchError("FAILED", `Unable to start a runner for session ${sessionId}`);
    }
    return { externalRef };
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.runners.get(sessionId);
    if (!entry || !isActive(entry)) return;
    entry.handle.requestStop();
  }

  async getStatus(sessionId: string): Promise<RunnerStatus | null> {
    const entry = this.runners.get(sessionId);
    if (!entry) return null;
    const status = entry.handle.getStatus();
    return {
      phase: entry.settled ? "ENDED" : status.phase,
      lastEventSequence: status.lastEventSequence,
    };
  }

  async countActive(): Promise<number> {
    let count = 0;
    for (const entry of this.runners.values()) {
      if (isActive(entry)) count += 1;
    }
    return count;
  }

  async shutdown(): Promise<void> {
    const entries = [...this.runners.values()];
    for (const entry of entries) {
      if (isActive(entry)) entry.handle.requestStop();
    }
    await Promise.all(entries.map((entry) => entry.finished));
  }
}
