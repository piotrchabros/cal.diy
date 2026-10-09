import process from "node:process";
import { runRunner } from "./runner/runRunner";

const FORCED_EXIT_DELAY_MS = 10_000;

// A browser that did not close within the runner's leave race would keep this process alive, and the
// launcher counts a session as active until the process exits.
const finish = (code: number): void => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), FORCED_EXIT_DELAY_MS).unref();
};

// When the controller dies the status pipe breaks; an unhandled EPIPE would kill a runner that is
// still in a meeting.
process.stdout.on("error", () => {});

runRunner({
  env: process.env,
  writeStatusLine: (line) => {
    process.stdout.write(`${line}\n`);
  },
  onStopSignal: (handler) => {
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  },
}).then(
  (code) => finish(code),
  () => finish(1)
);
