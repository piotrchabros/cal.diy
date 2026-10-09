import path from "node:path";
import process from "node:process";
import { type ControllerConfig, pickRunnerEnv } from "../../config";
import type { Logger } from "../../logger";
import { ChildProcessMeetingRunnerLauncher } from "./ChildProcessMeetingRunnerLauncher";
import { DockerEngineClient } from "./DockerEngineClient";
import { DockerMeetingRunnerLauncher } from "./DockerMeetingRunnerLauncher";
import type { MeetingRunnerLauncher } from "./MeetingRunnerLauncher";

// A runner child without these cannot find its binaries or a display for headed Chrome.
const CHILD_PROCESS_PASSTHROUGH_KEYS = ["PATH", "HOME", "DISPLAY"] as const;

// The running main file is the reference, not __filename: under tsx __filename is this factory's own
// path, and in the bundle it is the bundle's.
function resolveRunnerMainPath(mainPath: string): string {
  const resolved = path.resolve(mainPath);
  return path.join(path.dirname(resolved), `runnerMain${path.extname(resolved)}`);
}

function createChildProcessLauncher(input: {
  env: NodeJS.ProcessEnv;
  logger: Logger;
  mainPath: string | undefined;
}): MeetingRunnerLauncher {
  const mainPath = input.mainPath ?? process.argv[1];
  if (!mainPath) {
    throw new Error(
      "Unable to locate the runner entry file: the controller was started without a script path"
    );
  }

  const env = pickRunnerEnv(input.env);
  for (const key of CHILD_PROCESS_PASSTHROUGH_KEYS) {
    const value = input.env[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }

  return new ChildProcessMeetingRunnerLauncher({
    command: process.execPath,
    // execArgv carries the tsx loader flags into the child.
    args: [...process.execArgv, resolveRunnerMainPath(mainPath)],
    env,
    logger: input.logger,
  });
}

function createMeetingRunnerLauncher(input: {
  config: ControllerConfig;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  mainPath?: string;
}): MeetingRunnerLauncher {
  const { config, env, logger } = input;

  switch (config.launcher) {
    case "child_process":
      return createChildProcessLauncher({ env, logger, mainPath: input.mainPath });
    case "docker": {
      // getControllerConfig already refuses a docker launcher without an image; this narrows the type.
      if (config.docker === null) {
        throw new Error("The docker launcher needs NOTETAKER_RUNNER_IMAGE");
      }
      return new DockerMeetingRunnerLauncher({
        engine: new DockerEngineClient({ socketPath: config.docker.socketPath }),
        image: config.docker.image,
        env: pickRunnerEnv(env),
        capacity: config.capacity,
        networkMode: config.docker.networkMode,
        logger,
      });
    }
  }
}

export { createMeetingRunnerLauncher, resolveRunnerMainPath };
