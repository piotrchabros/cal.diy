import { queue, type schemaTask } from "@trigger.dev/sdk";

type NotetakerTask = Pick<Parameters<typeof schemaTask>[0], "machine" | "retry" | "queue">;

// Concurrency, machine and backoff are conservative starting values; size them from production volume in task T203.
export const notetakerQueue = queue({
  name: "notetaker",
  concurrencyLimit: 5,
});

export const notetakerTaskConfig: NotetakerTask = {
  machine: "small-1x",
  queue: notetakerQueue,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 60000,
    maxTimeoutInMs: 300000,
    randomize: true,
    outOfMemory: {
      machine: "medium-1x",
    },
  },
};
