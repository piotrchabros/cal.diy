import process from "node:process";
import { createLogger } from "./logger";
import { startAgentBrowser } from "./startAgentBrowser";

const FORCED_EXIT_DELAY_MS = 10_000;

startAgentBrowser(process.env).then(
  (agentBrowser) => {
    let closing = false;

    const onStopSignal = (): void => {
      if (closing) return;
      closing = true;
      // A browser that hangs on close must not keep the container from stopping.
      setTimeout(() => process.exit(0), FORCED_EXIT_DELAY_MS).unref();
      void agentBrowser.close().then(() => {
        process.exitCode = 0;
      });
    };

    process.on("SIGTERM", onStopSignal);
    process.on("SIGINT", onStopSignal);
  },
  (error: unknown) => {
    // Configuration errors name variables and rules only, never values, so the message is safe to log.
    createLogger().error("agent browser failed to start", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    process.exitCode = 1;
  }
);
