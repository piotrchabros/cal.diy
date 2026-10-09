import type { ILogger } from "@calcom/lib/tasker/types";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotetakerSyncTasker } from "./NotetakerSyncTasker";
import { NotetakerTaskService } from "./NotetakerTaskService";
import { NotetakerTriggerTasker } from "./NotetakerTriggerTasker";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
  NotetakerTasks,
} from "./types";

interface RegisteredTaskParams {
  id: string;
  run: (payload?: unknown) => Promise<void>;
  [key: string]: unknown;
}

// Each mocked task forwards to one shared spy with its own id, so a test can tell which task was triggered.
const sdkMocks = vi.hoisted(() => {
  const trigger =
    vi.fn<(taskId: string, payload: unknown, options?: TriggerOptions) => Promise<{ id: string }>>();
  return {
    trigger,
    queue: vi.fn((params: Record<string, unknown>) => params),
    schemaTask: vi.fn((params: RegisteredTaskParams) => ({
      ...params,
      trigger: (payload: unknown, options?: TriggerOptions) => trigger(params.id, payload, options),
    })),
    scheduledTask: vi.fn((params: RegisteredTaskParams) => params),
  };
});

const serviceMocks = vi.hoisted(() => ({
  finalize: vi.fn<(payload: NotetakerFinalizeSessionPayload) => Promise<void>>(),
  send: vi.fn<(payload: NotetakerSendNotificationPayload) => Promise<void>>(),
  dispatchDue: vi.fn<() => Promise<void>>(),
}));

const taskServiceMocks = vi.hoisted(() => ({
  finalizeSession: vi.fn<(payload: NotetakerFinalizeSessionPayload) => Promise<void>>(),
  generateSummary: vi.fn<(payload: NotetakerGenerateSummaryPayload) => Promise<void>>(),
  sendNotification: vi.fn<(payload: NotetakerSendNotificationPayload) => Promise<void>>(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  configure: vi.fn(),
  queue: sdkMocks.queue,
  schemaTask: sdkMocks.schemaTask,
  schedules: { task: sdkMocks.scheduledTask },
}));

vi.mock("@calcom/features/notetaker/di/NotetakerFinalizeService.container", () => ({
  getNotetakerFinalizeService: () => ({ finalize: serviceMocks.finalize }),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerNotificationService.container", () => ({
  getNotetakerNotificationService: () => ({ send: serviceMocks.send }),
}));

vi.mock("@calcom/features/notetaker/di/NotetakerDispatchService.container", () => ({
  getNotetakerDispatchService: () => ({ dispatchDue: serviceMocks.dispatchDue }),
}));

vi.mock("@calcom/lib/redactError", () => ({
  redactError: (err: unknown) => err,
}));

const createMockLogger = (): ILogger => ({
  log: vi.fn(),
  silly: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getSubLogger: vi.fn(),
});

type TaskerMode = "async" | "flagOff" | "envMissing";

// Every mode sets all five variables: vitest copies the root .env into process.env, and
// ENABLE_ASYNC_TASKER is also forced off when either E2E variable is set.
const MODE_ENV: Record<TaskerMode, Record<string, string>> = {
  async: {
    ENABLE_ASYNC_TASKER: "true",
    TRIGGER_SECRET_KEY: "test-secret",
    TRIGGER_API_URL: "https://trigger.test",
    NEXT_PUBLIC_IS_E2E: "",
    IS_E2E: "",
  },
  flagOff: {
    ENABLE_ASYNC_TASKER: "false",
    TRIGGER_SECRET_KEY: "test-secret",
    TRIGGER_API_URL: "https://trigger.test",
    NEXT_PUBLIC_IS_E2E: "",
    IS_E2E: "",
  },
  envMissing: {
    ENABLE_ASYNC_TASKER: "true",
    TRIGGER_SECRET_KEY: "",
    TRIGGER_API_URL: "",
    NEXT_PUBLIC_IS_E2E: "",
    IS_E2E: "",
  },
};

// The async/sync decision in @calcom/lib/tasker/Tasker is a module constant, so the module
// graph has to be re-evaluated after the env is stubbed.
function applyMode(mode: TaskerMode): void {
  vi.resetModules();
  for (const [key, value] of Object.entries(MODE_ENV[mode])) {
    vi.stubEnv(key, value);
  }
}

async function loadNotetakerTasker(mode: TaskerMode) {
  applyMode(mode);
  return (await import("./NotetakerTasker")).NotetakerTasker;
}

const finalizeSessionPayload: NotetakerFinalizeSessionPayload = { sessionId: "session-1" };
const generateSummaryPayload: NotetakerGenerateSummaryPayload = {
  transcriptId: "transcript-1",
  requestedByUserId: null,
};
const sendNotificationPayload: NotetakerSendNotificationPayload = {
  kind: "RESULTS_READY",
  bookingId: 1,
  sessionId: "session-1",
};
const options: TriggerOptions = { idempotencyKey: "notetaker:RESULTS_READY:session-1" };

interface TaskCase {
  name: keyof INotetakerTasker;
  payload: unknown;
  callService: (service: NotetakerTasks) => Promise<void>;
  callTasker: (tasker: INotetakerTasker, options?: TriggerOptions) => Promise<{ runId: string }>;
}

const taskCases: TaskCase[] = [
  {
    name: "finalizeSession",
    payload: finalizeSessionPayload,
    callService: (service) => service.finalizeSession(finalizeSessionPayload),
    callTasker: (tasker, triggerOptions) => tasker.finalizeSession(finalizeSessionPayload, triggerOptions),
  },
  {
    name: "generateSummary",
    payload: generateSummaryPayload,
    callService: (service) => service.generateSummary(generateSummaryPayload),
    callTasker: (tasker, triggerOptions) => tasker.generateSummary(generateSummaryPayload, triggerOptions),
  },
  {
    name: "sendNotification",
    payload: sendNotificationPayload,
    callService: (service) => service.sendNotification(sendNotificationPayload),
    callTasker: (tasker, triggerOptions) => tasker.sendNotification(sendNotificationPayload, triggerOptions),
  },
];

const scaffoldCases = taskCases.filter(({ name }) => name === "generateSummary");

const TASK_SERVICE_CONTAINER = "@calcom/features/notetaker/di/tasker/NotetakerTaskService.container";

function stubServiceResolves(service: NotetakerTaskService): void {
  vi.spyOn(service, "finalizeSession").mockResolvedValue(undefined);
  vi.spyOn(service, "generateSummary").mockResolvedValue(undefined);
  vi.spyOn(service, "sendNotification").mockResolvedValue(undefined);
}

function stubServiceRejects(service: NotetakerTaskService, error: Error): void {
  vi.spyOn(service, "finalizeSession").mockRejectedValue(error);
  vi.spyOn(service, "generateSummary").mockRejectedValue(error);
  vi.spyOn(service, "sendNotification").mockRejectedValue(error);
}

function stubAsyncResolves(asyncTasker: NotetakerTriggerTasker): void {
  vi.spyOn(asyncTasker, "finalizeSession").mockResolvedValue({ runId: "run_async_1" });
  vi.spyOn(asyncTasker, "generateSummary").mockResolvedValue({ runId: "run_async_1" });
  vi.spyOn(asyncTasker, "sendNotification").mockResolvedValue({ runId: "run_async_1" });
}

function spyOnSyncTasker(syncTasker: NotetakerSyncTasker): void {
  vi.spyOn(syncTasker, "finalizeSession");
  vi.spyOn(syncTasker, "generateSummary");
  vi.spyOn(syncTasker, "sendNotification");
}

function createTaskers() {
  const logger = createMockLogger();
  const service = new NotetakerTaskService({ logger });
  const asyncTasker = new NotetakerTriggerTasker({ logger });
  const syncTasker = new NotetakerSyncTasker({ logger, notetakerTaskService: service });
  return { logger, service, asyncTasker, syncTasker };
}

// vi.restoreAllMocks() only restores spies, so the hoisted mocks are reset by hand.
beforeEach(() => {
  sdkMocks.trigger.mockReset();
  sdkMocks.queue.mockClear();
  sdkMocks.schemaTask.mockClear();
  sdkMocks.scheduledTask.mockClear();
  serviceMocks.finalize.mockReset();
  serviceMocks.send.mockReset();
  serviceMocks.dispatchDue.mockReset();
  taskServiceMocks.finalizeSession.mockReset();
  taskServiceMocks.generateSummary.mockReset();
  taskServiceMocks.sendNotification.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("NotetakerTaskService", () => {
  describe("scaffold", () => {
    it.each(scaffoldCases)("$name rejects until it is wired", async ({ name, callService }) => {
      const service = new NotetakerTaskService({ logger: createMockLogger() });

      await expect(callService(service)).rejects.toMatchObject({
        message: `Notetaker task "${name}" is not wired yet`,
        code: "internal_server_error",
      });
    });
  });

  describe("wired tasks", () => {
    it("finalizeSession delegates to the finalize service", async () => {
      serviceMocks.finalize.mockResolvedValue(undefined);
      const service = new NotetakerTaskService({ logger: createMockLogger() });

      await service.finalizeSession(finalizeSessionPayload);

      expect(serviceMocks.finalize).toHaveBeenCalledTimes(1);
      expect(serviceMocks.finalize).toHaveBeenCalledWith(finalizeSessionPayload);
      expect(serviceMocks.send).not.toHaveBeenCalled();
    });

    it("sendNotification delegates to the notification service", async () => {
      serviceMocks.send.mockResolvedValue(undefined);
      const service = new NotetakerTaskService({ logger: createMockLogger() });

      await service.sendNotification(sendNotificationPayload);

      expect(serviceMocks.send).toHaveBeenCalledTimes(1);
      expect(serviceMocks.send).toHaveBeenCalledWith(sendNotificationPayload);
      expect(serviceMocks.finalize).not.toHaveBeenCalled();
    });

    it("propagates a finalize service error", async () => {
      serviceMocks.finalize.mockRejectedValue(new Error("finalize failed"));
      const service = new NotetakerTaskService({ logger: createMockLogger() });

      await expect(service.finalizeSession(finalizeSessionPayload)).rejects.toThrow("finalize failed");
    });

    it("propagates a notification service error", async () => {
      serviceMocks.send.mockRejectedValue(new Error("send failed"));
      const service = new NotetakerTaskService({ logger: createMockLogger() });

      await expect(service.sendNotification(sendNotificationPayload)).rejects.toThrow("send failed");
    });
  });
});

describe("NotetakerTriggerTasker", () => {
  describe("scaffold", () => {
    it.each(scaffoldCases)("$name rejects until it is wired", async ({ name, callTasker }) => {
      const asyncTasker = new NotetakerTriggerTasker({ logger: createMockLogger() });

      await expect(callTasker(asyncTasker, options)).rejects.toMatchObject({
        message: `Notetaker task "${name}" is not wired yet`,
        code: "internal_server_error",
      });
    });
  });

  describe("wired tasks", () => {
    it("finalizeSession triggers the finalize task and returns its run id", async () => {
      sdkMocks.trigger.mockResolvedValue({ id: "run_finalize_1" });
      const asyncTasker = new NotetakerTriggerTasker({ logger: createMockLogger() });

      const result = await asyncTasker.finalizeSession(finalizeSessionPayload, options);

      expect(sdkMocks.trigger).toHaveBeenCalledTimes(1);
      expect(sdkMocks.trigger).toHaveBeenCalledWith(
        "notetaker.finalize-session",
        finalizeSessionPayload,
        options
      );
      expect(result).toEqual({ runId: "run_finalize_1" });
    });

    it("sendNotification triggers the notification task and returns its run id", async () => {
      sdkMocks.trigger.mockResolvedValue({ id: "run_notification_1" });
      const asyncTasker = new NotetakerTriggerTasker({ logger: createMockLogger() });

      const result = await asyncTasker.sendNotification(sendNotificationPayload, options);

      expect(sdkMocks.trigger).toHaveBeenCalledTimes(1);
      expect(sdkMocks.trigger).toHaveBeenCalledWith(
        "notetaker.send-notification",
        sendNotificationPayload,
        options
      );
      expect(result).toEqual({ runId: "run_notification_1" });
    });

    it("propagates a trigger failure so the tasker can fall back", async () => {
      sdkMocks.trigger.mockRejectedValue(new Error("trigger down"));
      const asyncTasker = new NotetakerTriggerTasker({ logger: createMockLogger() });

      await expect(asyncTasker.finalizeSession(finalizeSessionPayload, options)).rejects.toThrow(
        "trigger down"
      );
    });
  });
});

describe("notetaker trigger tasks", () => {
  // The task files register at import time, so each case needs a fresh module graph. The task service
  // container is mocked only here; the DI container cases below need the real one.
  beforeEach(() => {
    vi.resetModules();
    vi.doMock(TASK_SERVICE_CONTAINER, () => ({
      getNotetakerTaskService: () => taskServiceMocks,
    }));
  });

  afterEach(() => {
    vi.doUnmock(TASK_SERVICE_CONTAINER);
  });

  it("finalize-session registers a schema task with the shared config", async () => {
    const { notetakerTaskConfig } = await import("./trigger/config");
    const { notetakerFinalizeSessionSchema } = await import("./trigger/schema");
    const { FINALIZE_SESSION_JOB_ID } = await import("./trigger/finalize-session");

    expect(FINALIZE_SESSION_JOB_ID).toBe("notetaker.finalize-session");
    expect(sdkMocks.schemaTask).toHaveBeenCalledTimes(1);
    const [params] = sdkMocks.schemaTask.mock.calls[0];
    expect(params.id).toBe("notetaker.finalize-session");
    expect(params.schema).toBe(notetakerFinalizeSessionSchema);
    expect(params.machine).toBe(notetakerTaskConfig.machine);
    expect(params.queue).toBe(notetakerTaskConfig.queue);
    expect(params.retry).toEqual(notetakerTaskConfig.retry);
  });

  it("finalize-session run calls the task service", async () => {
    taskServiceMocks.finalizeSession.mockResolvedValue(undefined);
    await import("./trigger/finalize-session");
    const [params] = sdkMocks.schemaTask.mock.calls[0];

    await params.run(finalizeSessionPayload);

    expect(taskServiceMocks.finalizeSession).toHaveBeenCalledTimes(1);
    expect(taskServiceMocks.finalizeSession).toHaveBeenCalledWith(finalizeSessionPayload);
    expect(taskServiceMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("send-notification registers a schema task with the shared config", async () => {
    const { notetakerTaskConfig } = await import("./trigger/config");
    const { notetakerSendNotificationSchema } = await import("./trigger/schema");
    const { SEND_NOTIFICATION_JOB_ID } = await import("./trigger/send-notification");

    expect(SEND_NOTIFICATION_JOB_ID).toBe("notetaker.send-notification");
    expect(sdkMocks.schemaTask).toHaveBeenCalledTimes(1);
    const [params] = sdkMocks.schemaTask.mock.calls[0];
    expect(params.id).toBe("notetaker.send-notification");
    expect(params.schema).toBe(notetakerSendNotificationSchema);
    expect(params.machine).toBe(notetakerTaskConfig.machine);
    expect(params.queue).toBe(notetakerTaskConfig.queue);
    expect(params.retry).toEqual(notetakerTaskConfig.retry);
  });

  it("send-notification run calls the task service", async () => {
    taskServiceMocks.sendNotification.mockResolvedValue(undefined);
    await import("./trigger/send-notification");
    const [params] = sdkMocks.schemaTask.mock.calls[0];

    await params.run(sendNotificationPayload);

    expect(taskServiceMocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(taskServiceMocks.sendNotification).toHaveBeenCalledWith(sendNotificationPayload);
    expect(taskServiceMocks.finalizeSession).not.toHaveBeenCalled();
  });

  it("dispatch-due-sessions registers a scheduled task that runs every minute in UTC", async () => {
    const { notetakerTaskConfig } = await import("./trigger/config");
    const { DISPATCH_DUE_SESSIONS_JOB_ID } = await import("./trigger/dispatch-due-sessions");

    expect(DISPATCH_DUE_SESSIONS_JOB_ID).toBe("notetaker.dispatch-due-sessions");
    expect(sdkMocks.scheduledTask).toHaveBeenCalledTimes(1);
    expect(sdkMocks.schemaTask).not.toHaveBeenCalled();
    const [params] = sdkMocks.scheduledTask.mock.calls[0];
    expect(params.id).toBe("notetaker.dispatch-due-sessions");
    expect(params.cron).toEqual({ pattern: "* * * * *", timezone: "UTC" });
    expect(params.machine).toBe(notetakerTaskConfig.machine);
    expect(params.queue).toBe(notetakerTaskConfig.queue);
    expect(params.retry).toEqual(notetakerTaskConfig.retry);
  });

  it("dispatch-due-sessions run sweeps the due sessions", async () => {
    serviceMocks.dispatchDue.mockResolvedValue(undefined);
    await import("./trigger/dispatch-due-sessions");
    const [params] = sdkMocks.scheduledTask.mock.calls[0];

    await params.run();

    expect(serviceMocks.dispatchDue).toHaveBeenCalledTimes(1);
    expect(serviceMocks.dispatchDue).toHaveBeenCalledWith();
  });
});

describe("NotetakerSyncTasker", () => {
  it.each(taskCases)("$name runs the task service inline and returns a sync run id", async ({
    name,
    payload,
    callTasker,
  }) => {
    const { service, syncTasker } = createTaskers();
    stubServiceResolves(service);

    const result = await callTasker(syncTasker);

    expect(service[name]).toHaveBeenCalledTimes(1);
    expect(service[name]).toHaveBeenCalledWith(payload);
    expect(result.runId).toMatch(/^sync_.{10}$/);
  });

  it("propagates task service errors", async () => {
    const { service, syncTasker } = createTaskers();
    stubServiceRejects(service, new Error("boom"));

    await expect(syncTasker.finalizeSession(finalizeSessionPayload)).rejects.toThrow("boom");
  });
});

describe("NotetakerTasker", () => {
  describe("when async tasker is enabled", () => {
    it.each(taskCases)("$name dispatches to the trigger tasker with payload and options", async ({
      name,
      payload,
      callTasker,
    }) => {
      const NotetakerTasker = await loadNotetakerTasker("async");
      const { logger, asyncTasker, syncTasker } = createTaskers();
      stubAsyncResolves(asyncTasker);
      spyOnSyncTasker(syncTasker);
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      const result = await callTasker(tasker, options);

      expect(asyncTasker[name]).toHaveBeenCalledTimes(1);
      expect(asyncTasker[name]).toHaveBeenCalledWith(payload, options);
      expect(result).toEqual({ runId: "run_async_1" });
      expect(syncTasker[name]).not.toHaveBeenCalled();
    });

    it("falls back to the sync tasker when the trigger tasker fails", async () => {
      const NotetakerTasker = await loadNotetakerTasker("async");
      const { logger, service, asyncTasker, syncTasker } = createTaskers();
      vi.spyOn(asyncTasker, "finalizeSession").mockRejectedValue(new Error("trigger down"));
      stubServiceResolves(service);
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      const result = await tasker.finalizeSession(finalizeSessionPayload, options);

      expect(result.runId).toMatch(/^sync_/);
      expect(service.finalizeSession).toHaveBeenCalledWith(finalizeSessionPayload);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("returns task-failed when both the trigger and sync taskers fail", async () => {
      const NotetakerTasker = await loadNotetakerTasker("async");
      const { logger, service, asyncTasker, syncTasker } = createTaskers();
      vi.spyOn(asyncTasker, "finalizeSession").mockRejectedValue(new Error("trigger down"));
      stubServiceRejects(service, new Error("boom"));
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      const result = await tasker.finalizeSession(finalizeSessionPayload, options);

      expect(result).toEqual({ runId: "task-failed" });
    });
  });

  describe("when ENABLE_ASYNC_TASKER is off", () => {
    it.each(taskCases)("$name runs through the sync tasker", async ({ name, payload, callTasker }) => {
      const NotetakerTasker = await loadNotetakerTasker("flagOff");
      const { logger, service, asyncTasker, syncTasker } = createTaskers();
      stubAsyncResolves(asyncTasker);
      stubServiceResolves(service);
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      const result = await callTasker(tasker, options);

      expect(asyncTasker[name]).not.toHaveBeenCalled();
      expect(service[name]).toHaveBeenCalledWith(payload);
      expect(result.runId).toMatch(/^sync_/);
    });

    it("passes payload and options through to the sync tasker", async () => {
      const NotetakerTasker = await loadNotetakerTasker("flagOff");
      const { logger, service, asyncTasker, syncTasker } = createTaskers();
      stubServiceResolves(service);
      spyOnSyncTasker(syncTasker);
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      await tasker.finalizeSession(finalizeSessionPayload, options);

      expect(syncTasker.finalizeSession).toHaveBeenCalledWith(finalizeSessionPayload, options);
    });

    it("logs a failed task and returns task-failed instead of throwing", async () => {
      const NotetakerTasker = await loadNotetakerTasker("flagOff");
      const { logger, service, asyncTasker, syncTasker } = createTaskers();
      stubServiceRejects(service, new Error("boom"));
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      await expect(tasker.finalizeSession(finalizeSessionPayload)).resolves.toEqual({
        runId: "task-failed",
      });
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("when trigger env variables are missing", () => {
    it("runs through the sync tasker and logs the fallback", async () => {
      const NotetakerTasker = await loadNotetakerTasker("envMissing");
      const { logger, service, asyncTasker, syncTasker } = createTaskers();
      stubAsyncResolves(asyncTasker);
      stubServiceResolves(service);
      const tasker = new NotetakerTasker({ asyncTasker, syncTasker, logger });

      const result = await tasker.finalizeSession(finalizeSessionPayload, options);

      expect(asyncTasker.finalizeSession).not.toHaveBeenCalled();
      expect(service.finalizeSession).toHaveBeenCalledWith(finalizeSessionPayload);
      expect(result.runId).toMatch(/^sync_/);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Missing env variables TRIGGER_SECRET_KEY or TRIGGER_API_URL")
      );
    });
  });
});

describe("notetaker tasker DI containers", () => {
  it("resolves the tasker with its sync and trigger taskers", async () => {
    applyMode("flagOff");
    const { getNotetakerTasker } = await import(
      "@calcom/features/notetaker/di/tasker/NotetakerTasker.container"
    );

    const tasker = getNotetakerTasker();

    expect(tasker.dependencies.syncTasker.dependencies.notetakerTaskService).toBeDefined();
    expect(tasker.dependencies.asyncTasker).toBeDefined();
  });

  it("resolves the task service with a logger", async () => {
    applyMode("flagOff");
    const { getNotetakerTaskService } = await import(
      "@calcom/features/notetaker/di/tasker/NotetakerTaskService.container"
    );

    expect(getNotetakerTaskService().dependencies.logger).toBeDefined();
  });
});
