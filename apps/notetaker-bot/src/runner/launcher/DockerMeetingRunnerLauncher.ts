// UNVERIFIED AGAINST THE REAL SERVICE (Docker Engine API): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/deployment.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import type { Logger } from "../../logger";
import type { DockerContainerSpec, IDockerEngine } from "./DockerEngineClient";
import type { MeetingRunnerLauncher, RunnerStatus } from "./MeetingRunnerLauncher";
import { RunnerLaunchError } from "./MeetingRunnerLauncher";
import { encodeJoinRequestEnv, findLastRunnerStatus, RUNNER_JOIN_REQUEST_ENV } from "./runnerStatusProtocol";

type DockerMeetingRunnerLauncherDeps = {
  engine: IDockerEngine;
  image: string;
  env: Record<string, string>;
  capacity: number;
  networkMode: string | null;
  logger: Logger;
};

type LaunchStep = "inspect" | "list" | "create" | "start";

const RUNNER_SESSION_LABEL = "com.cal.notetaker.session";

// Chromium crashes on large pages with the 64 MiB shared memory a container gets by default.
const SHM_SIZE_BYTES = 1073741824;
const STOP_GRACE_SECONDS = 15;
const LOG_TAIL_LINES = 50;

function containerName(sessionId: string): string {
  return `notetaker-${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function buildSpec(
  deps: DockerMeetingRunnerLauncherDeps,
  request: NotetakerBotJoinRequest
): DockerContainerSpec {
  const configuredEnv = Object.entries(deps.env)
    .filter(([key]) => key !== RUNNER_JOIN_REQUEST_ENV)
    .map(([key, value]) => `${key}=${value}`);

  return {
    name: containerName(request.sessionId),
    image: deps.image,
    env: [...configuredEnv, `${RUNNER_JOIN_REQUEST_ENV}=${encodeJoinRequestEnv(request)}`],
    labels: { [RUNNER_SESSION_LABEL]: request.sessionId },
    shmSizeBytes: SHM_SIZE_BYTES,
    networkMode: deps.networkMode,
  };
}

function countRunning(containers: { running: boolean }[]): number {
  return containers.filter((container) => container.running).length;
}

// Engine error messages can echo the request, which carries the secret and the join request.
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

// The Engine is the only record of sessions, so runner containers survive a controller restart and
// several controllers can share one Engine. The class therefore keeps nothing but its dependencies.
class DockerMeetingRunnerLauncher implements MeetingRunnerLauncher {
  private readonly deps: DockerMeetingRunnerLauncherDeps;

  constructor(deps: DockerMeetingRunnerLauncherDeps) {
    this.deps = deps;
  }

  async launch(request: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
    const { engine, capacity, logger } = this.deps;
    const sessionId = request.sessionId;

    // Looked up before the capacity check so a repeated join for a known session succeeds at capacity.
    const existing = await this.runLaunchStep(sessionId, "inspect", () =>
      engine.inspectContainer(containerName(sessionId))
    );
    if (existing) return { externalRef: existing.id };

    const containers = await this.runLaunchStep(sessionId, "list", () =>
      engine.listContainers(RUNNER_SESSION_LABEL)
    );
    if (countRunning(containers) >= capacity) {
      throw new RunnerLaunchError(
        "AT_CAPACITY",
        `The Docker launcher is at capacity (${capacity} running runner containers)`
      );
    }

    const created = await this.runLaunchStep(sessionId, "create", () =>
      engine.createContainer(buildSpec(this.deps, request))
    );
    // A concurrent launch for the same session won the name; that launch starts the container.
    if (created.alreadyExists) return { externalRef: created.id };

    await this.runLaunchStep(sessionId, "start", () => this.startOrRemove(created.id));

    logger.info("runner container started", { sessionId, containerId: created.id });
    return { externalRef: created.id };
  }

  async stop(sessionId: string): Promise<void> {
    const { engine, logger } = this.deps;

    const container = await engine.inspectContainer(containerName(sessionId));
    if (!container) return;

    if (container.running) await engine.stopContainer(container.id, STOP_GRACE_SECONDS);

    try {
      await this.removeIfPresent(container.id);
    } catch (error) {
      logger.warn("runner container could not be removed", { sessionId, errorName: errorNameOf(error) });
    }
  }

  async getStatus(sessionId: string): Promise<RunnerStatus | null> {
    const { engine } = this.deps;

    const container = await engine.inspectContainer(containerName(sessionId));
    if (!container) return null;

    if (container.running) {
      const logTail = await engine.readLogTail(container.id, LOG_TAIL_LINES);
      return findLastRunnerStatus(logTail) ?? { phase: "STARTING", lastEventSequence: 0 };
    }

    return { phase: "ENDED", lastEventSequence: await this.readLastSequence(container.id) };
  }

  async countActive(): Promise<number> {
    return countRunning(await this.deps.engine.listContainers(RUNNER_SESSION_LABEL));
  }

  async shutdown(): Promise<void> {
    const { engine, logger } = this.deps;

    let containers: { id: string; running: boolean }[];
    try {
      containers = await engine.listContainers(RUNNER_SESSION_LABEL);
    } catch (error) {
      logger.warn("runner containers could not be listed for shutdown", { errorName: errorNameOf(error) });
      return;
    }

    const results = await Promise.allSettled(
      containers
        .filter((container) => container.running)
        .map(async (container) => {
          await engine.stopContainer(container.id, STOP_GRACE_SECONDS);
          await this.removeIfPresent(container.id);
        })
    );

    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) logger.warn("runner containers could not be stopped on shutdown", { failed });
  }

  private async runLaunchStep<T>(sessionId: string, step: LaunchStep, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RunnerLaunchError) throw error;
      this.deps.logger.error("runner container could not be started", {
        sessionId,
        step,
        errorName: errorNameOf(error),
      });
      throw new RunnerLaunchError(
        "FAILED",
        `Unable to start a runner container for session ${sessionId}: ${step} failed`
      );
    }
  }

  private async startOrRemove(containerId: string): Promise<void> {
    const { engine } = this.deps;
    try {
      await engine.startContainer(containerId);
    } catch (startError) {
      // A created container that never started would hold the session's name and block every retry.
      try {
        await engine.removeContainer(containerId);
      } catch {
        // The start failure is the one worth reporting.
      }
      throw startError;
    }
  }

  // A container created with auto-removal is usually gone by the time its stop returns.
  private async removeIfPresent(containerId: string): Promise<void> {
    const { engine } = this.deps;
    const remaining = await engine.inspectContainer(containerId);
    if (remaining) await engine.removeContainer(containerId);
  }

  private async readLastSequence(containerId: string): Promise<number> {
    try {
      const logTail = await this.deps.engine.readLogTail(containerId, LOG_TAIL_LINES);
      return findLastRunnerStatus(logTail)?.lastEventSequence ?? 0;
    } catch {
      // The logs of an ended container may already be gone; the phase is still known.
      return 0;
    }
  }
}

export { DockerMeetingRunnerLauncher, RUNNER_SESSION_LABEL };
