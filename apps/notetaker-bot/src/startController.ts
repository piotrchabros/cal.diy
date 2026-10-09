import type { Server } from "node:http";
import { getControllerConfig } from "./config";
import { createLogger } from "./logger";
import { createMeetingRunnerLauncher } from "./runner/launcher/createMeetingRunnerLauncher";
import { createControllerServer } from "./server";

type StartedController = { server: Server; close(): Promise<void> };

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function stopListening(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // The callback also receives an error when the server was not listening; there is nothing left to stop then.
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function startController(env: NodeJS.ProcessEnv): Promise<StartedController> {
  const config = getControllerConfig(env);
  const logger = createLogger({ level: config.logLevel, base: { component: "controller" } });
  const launcher = createMeetingRunnerLauncher({ config, env, logger });
  const server = createControllerServer({
    secret: config.secret,
    capacity: config.capacity,
    launcher,
    logger,
    skipMeetingUrlCheck: config.adapterMode === "fake",
  });

  await listen(server, config.port, config.host);

  const address = server.address();
  logger.info("controller listening", {
    host: config.host,
    port: address !== null && typeof address !== "string" ? address.port : config.port,
    launcher: config.launcher,
    adapterMode: config.adapterMode,
  });

  let closing: Promise<void> | null = null;

  const closeOnce = async (): Promise<void> => {
    await stopListening(server);
    try {
      await launcher.shutdown();
    } catch (error) {
      logger.error("launcher shutdown failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  };

  return {
    server,
    close: () => {
      closing ??= closeOnce();
      return closing;
    },
  };
}

export { startController };
export type { StartedController };
