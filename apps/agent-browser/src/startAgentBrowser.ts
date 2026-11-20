import type { Server } from "node:http";
import packageJson from "../package.json";
import { PlaywrightBrowserDriver } from "./browser/PlaywrightBrowserDriver";
import { getAgentBrowserConfig } from "./config";
import type { Logger } from "./logger";
import { createLogger } from "./logger";
import { createControlServer } from "./server/controlServer";
import { createViewerServer } from "./server/viewerServer";
import type { IBrowserDriver } from "./sessions/IBrowserDriver";
import { SessionManager } from "./sessions/SessionManager";
import { ViewerHub } from "./viewer/ViewerHub";

const REAP_INTERVAL_MS = 30_000;

type StartedAgentBrowser = {
  controlServer: Server;
  viewerServer: Server;
  close(): Promise<void>;
};

type StartOverrides = {
  // Tests pass a fake so no Chromium is launched.
  createDriver?: (logger: Logger) => IBrowserDriver;
  logger?: Logger;
};

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

function boundPort(server: Server, fallback: number): number {
  const address = server.address();
  return address !== null && typeof address !== "string" ? address.port : fallback;
}

async function startAgentBrowser(
  env: NodeJS.ProcessEnv,
  overrides: StartOverrides = {}
): Promise<StartedAgentBrowser> {
  const config = getAgentBrowserConfig(env);
  const logger =
    overrides.logger ?? createLogger({ level: config.logLevel, base: { component: "agent-browser" } });

  const driver =
    overrides.createDriver?.(logger) ??
    new PlaywrightBrowserDriver({
      chromiumSandbox: config.chromiumSandbox,
      screencastFps: config.screencastFps,
      jpegQuality: config.jpegQuality,
      logger: logger.child({ component: "driver" }),
    });
  const hub = new ViewerHub({ logger: logger.child({ component: "viewers" }) });
  const sessions = new SessionManager({
    driver,
    hub,
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.idleTimeoutSeconds * 1000,
    maxSessionMs: config.maxSessionSeconds * 1000,
    logger: logger.child({ component: "sessions" }),
  });
  const controlServer = createControlServer({
    secret: config.secret,
    sessions,
    hub,
    version: packageJson.version,
    logger: logger.child({ component: "control" }),
  });
  const viewer = createViewerServer({
    secret: config.secret,
    sessions,
    hub,
    logger: logger.child({ component: "viewer" }),
  });

  try {
    await listen(controlServer, config.controlPort, config.host);
    await listen(viewer.server, config.viewerPort, config.host);
  } catch (error) {
    await Promise.all([stopListening(controlServer), viewer.close()]);
    await driver.close();
    throw error;
  }

  const reaper = setInterval(() => {
    sessions.reap().catch((error: unknown) => {
      logger.error("session reaper failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  }, REAP_INTERVAL_MS);
  reaper.unref();

  logger.info("agent browser listening", {
    host: config.host,
    controlPort: boundPort(controlServer, config.controlPort),
    viewerPort: boundPort(viewer.server, config.viewerPort),
    maxSessions: config.maxSessions,
  });

  let closing: Promise<void> | null = null;

  const closeOnce = async (): Promise<void> => {
    clearInterval(reaper);
    // Viewers get a restart close rather than `closed`, so a page being presented reconnects after a redeploy.
    hub.closeEveryViewer();
    await Promise.all([stopListening(controlServer), viewer.close()]);
    try {
      await sessions.disposeAll();
      await driver.close();
    } catch (error) {
      logger.error("browser shutdown failed", { error: error instanceof Error ? error.name : "unknown" });
    }
    logger.info("agent browser stopped");
  };

  return {
    controlServer,
    viewerServer: viewer.server,
    close: () => {
      closing ??= closeOnce();
      return closing;
    },
  };
}

export { startAgentBrowser };
export type { StartedAgentBrowser, StartOverrides };
