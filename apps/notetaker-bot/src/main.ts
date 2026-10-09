import process from "node:process";
import { createLogger } from "./logger";
import { startController } from "./startController";

const FORCED_EXIT_DELAY_MS = 10_000;

startController(process.env).then(
  (controller) => {
    let closing = false;

    const onStopSignal = (): void => {
      if (closing) return;
      closing = true;
      // A launcher that cannot stop its runners must not keep the controller alive forever.
      setTimeout(() => process.exit(0), FORCED_EXIT_DELAY_MS).unref();
      void controller.close().then(() => {
        process.exitCode = 0;
      });
    };

    process.on("SIGTERM", onStopSignal);
    process.on("SIGINT", onStopSignal);
  },
  (error: unknown) => {
    createLogger().error("controller failed to start", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    process.exitCode = 1;
  }
);
