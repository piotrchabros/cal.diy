import { getRunnerConfig } from "../config";
import { createLogger } from "../logger";
import { createMeetingRunner } from "./createMeetingRunner";
import {
  decodeJoinRequestEnv,
  encodeRunnerStatus,
  RUNNER_JOIN_REQUEST_ENV,
} from "./launcher/runnerStatusProtocol";
import type { MeetingRunner } from "./MeetingRunner";

function readStartUpInput(env: NodeJS.ProcessEnv) {
  return {
    config: getRunnerConfig(env),
    request: decodeJoinRequestEnv(env[RUNNER_JOIN_REQUEST_ENV]),
  };
}

export const STATUS_REPEAT_INTERVAL_MS = 15000;

export async function runRunner(input: {
  env: NodeJS.ProcessEnv;
  writeStatusLine: (line: string) => void;
  onStopSignal: (handler: () => void) => void;
}): Promise<number> {
  let runner: MeetingRunner | undefined;
  let stopRequested = false;

  // Registered before anything can fail or take time, so a signal during start-up is not lost.
  input.onStopSignal(() => {
    stopRequested = true;
    runner?.requestStop();
  });

  let startUp: ReturnType<typeof readStartUpInput>;
  try {
    startUp = readStartUpInput(input.env);
  } catch (error) {
    // Both readers build their messages from variable names, rules and field paths only, never from values.
    createLogger().error("runner configuration is invalid", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return 1;
  }

  const { config, request } = startUp;
  const logger = createLogger({ level: config.logLevel, base: { component: "runner" } });

  try {
    runner = createMeetingRunner({ request, config, logger });
  } catch (error) {
    logger.error("runner could not be created", { error: error instanceof Error ? error.name : "unknown" });
    return 1;
  }

  const activeRunner = runner;
  // The runner does not replay its status, so the listener must be in place before the start.
  activeRunner.onStatusChange((status) => input.writeStatusLine(encodeRunnerStatus(status)));

  // A stop before the start ends the session and turns the start below into a no-op.
  if (stopRequested) activeRunner.requestStop();
  activeRunner.start();

  // The Docker launcher reads the status from the tail of the container log, and log output can push
  // the last status line out of that tail.
  const statusRepeatTimer = setInterval(() => {
    try {
      input.writeStatusLine(encodeRunnerStatus(activeRunner.getStatus()));
    } catch (error) {
      logger.warn("status line could not be written", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }, STATUS_REPEAT_INTERVAL_MS);
  statusRepeatTimer.unref();

  const summary = await activeRunner.done;
  clearInterval(statusRepeatTimer);
  logger.info("runner finished", { endReason: summary.endReason, passageCount: summary.passageCount });
  return 0;
}
