// @vitest-environment node
import type { Server } from "node:http";
import process from "node:process";
import type { NotetakerBotEvent, NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotEventSchema,
  notetakerBotJoinResponseSchema,
  notetakerBotStateSchema,
  verifyNotetakerSignature,
} from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerConfig, RunnerConfig } from "./config";
import { getControllerConfig } from "./config";
import type { Logger } from "./logger";
import { createSilentLogger } from "./logger";
import { createMeetingRunner } from "./runner/createMeetingRunner";
import { InProcessMeetingRunnerLauncher } from "./runner/launcher/InProcessMeetingRunnerLauncher";
import type { MeetingRunnerLauncher, RunnerStatus } from "./runner/launcher/MeetingRunnerLauncher";
import {
  encodeJoinRequestEnv,
  findLastRunnerStatus,
  parseRunnerStatusLine,
  RUNNER_JOIN_REQUEST_ENV,
} from "./runner/launcher/runnerStatusProtocol";
import type { MeetingRunner } from "./runner/MeetingRunner";
import { runRunner } from "./runner/runRunner";
import { createControllerServer } from "./server";
import { startController } from "./startController";
import type { RecordedRequest, StubHttpServer } from "./testing/httpTestKit";
import {
  buildJoinRequest,
  buildSignedHeaders,
  startStubHttpServer,
  useRealFetch,
} from "./testing/httpTestKit";

type LauncherFactoryInput = { config: ControllerConfig; env: NodeJS.ProcessEnv; logger: Logger };

const mocks = vi.hoisted(() => {
  const holder: { launcher: MeetingRunnerLauncher | null } = { launcher: null };
  const createMeetingRunnerLauncher = vi.fn((_input: LauncherFactoryInput): MeetingRunnerLauncher => {
    if (!holder.launcher) throw new Error("The test did not provide a launcher");
    return holder.launcher;
  });
  return { holder, createMeetingRunnerLauncher };
});

// The real launcher loads the browser automation library at module load; this stand-in keeps it
// unloaded and turns any attempt to open a browser into a failure.
vi.mock("./platform/browser/PlaywrightChromeLauncher", () => ({
  PlaywrightChromeLauncher: class {
    async open(): Promise<never> {
      throw new Error("the contract loop must never open a browser");
    }
  },
}));

vi.mock("./runner/launcher/createMeetingRunnerLauncher", () => ({
  createMeetingRunnerLauncher: mocks.createMeetingRunnerLauncher,
}));

const SECRET = "test-secret-not-real";
const OTHER_SECRET = "another-test-secret-not-real";
const EVENTS_PATH = "/api/notetaker/events";
const OFF_PLATFORM_URL = "https://meet.example.test/abc";
const STOP_BODY = JSON.stringify({ reason: "STOPPED_BY_HOST" });
const TIMESTAMP_HEADER = NOTETAKER_TIMESTAMP_HEADER.toLowerCase();
const SIGNATURE_HEADER = NOTETAKER_SIGNATURE_HEADER.toLowerCase();
const DONE_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 5000;
const WAIT_OPTIONS = { timeout: 5000, interval: 10 };
const FULL_MEETING_TYPES = [
  "session.join_requested",
  "session.admitted",
  "session.notice_posted",
  "transcript.passages",
  "session.ended",
];

const fakeConfig: RunnerConfig = {
  secret: SECRET,
  adapterMode: "fake",
  fakeMeetingSeconds: 1,
  soniox: null,
  google: { joinMode: "guest", storageState: null, email: null, password: null },
  chrome: { channel: "chrome", headless: true },
  logLevel: "silent",
};

type Reply = { status: number; json: unknown };

type SendOptions = {
  method: "GET" | "POST";
  path: string;
  body?: string;
  sign?: boolean;
  secret?: string;
  timestampSeconds?: number;
};

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter += 1;
  return `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, "0")}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function send(baseUrl: string, options: SendOptions): Promise<Reply> {
  const signedHeaders =
    options.sign === false
      ? {}
      : buildSignedHeaders({
          secret: options.secret ?? SECRET,
          rawBody: options.body ?? "",
          timestampSeconds: options.timestampSeconds,
        });
  const response = await fetch(`${baseUrl}${options.path}`, {
    method: options.method,
    headers: { ...signedHeaders, "content-type": "application/json" },
    body: options.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : JSON.parse(text) };
}

function sessionPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}`;
}

function joinRequestFor(
  app: StubHttpServer,
  sessionId: string,
  overrides: Partial<NotetakerBotJoinRequest> = {}
): NotetakerBotJoinRequest {
  return buildJoinRequest({
    sessionId,
    callbackUrl: `${app.url}${EVENTS_PATH}`,
    scheduledStartAt: new Date().toISOString(),
    ...overrides,
  });
}

function parseEvents(app: StubHttpServer): NotetakerBotEvent[] {
  return app.requests.map((request) => notetakerBotEventSchema.parse(JSON.parse(request.rawBody)));
}

function eventTypes(app: StubHttpServer): string[] {
  return parseEvents(app).map((event) => event.type);
}

function isSignedWith(request: RecordedRequest, secret: string): boolean {
  return verifyNotetakerSignature({
    secret,
    timestamp: request.headers[TIMESTAMP_HEADER],
    signature: request.headers[SIGNATURE_HEADER],
    rawBody: request.rawBody,
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`The server is not bound to a TCP port, address was ${String(address)}`);
  }
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

describe("contract loop", () => {
  useRealFetch();

  describe("signed contract loop", () => {
    type Loop = {
      app: StubHttpServer;
      launcher: InProcessMeetingRunnerLauncher;
      server: Server;
      url: string;
      runners: Map<string, MeetingRunner>;
      createRunnerCalls: string[];
    };

    let loop: Loop | null = null;

    function currentLoop(): Loop {
      if (!loop) throw new Error("The loop was not started");
      return loop;
    }

    function doneOf(sessionId: string): ReturnType<typeof withTimeout<Awaited<MeetingRunner["done"]>>> {
      const runner = currentLoop().runners.get(sessionId);
      if (!runner) throw new Error(`No runner was created for session ${sessionId}`);
      return withTimeout(runner.done, DONE_TIMEOUT_MS, `runner ${sessionId}`);
    }

    function join(request: NotetakerBotJoinRequest): Promise<Reply> {
      return send(currentLoop().url, { method: "POST", path: "/v1/sessions", body: JSON.stringify(request) });
    }

    beforeEach(async () => {
      const app = await startStubHttpServer();
      const runners = new Map<string, MeetingRunner>();
      const createRunnerCalls: string[] = [];
      const launcher = new InProcessMeetingRunnerLauncher({
        createRunner: (request) => {
          createRunnerCalls.push(request.sessionId);
          const runner = createMeetingRunner({ request, config: fakeConfig, logger: createSilentLogger() });
          runners.set(request.sessionId, runner);
          return runner;
        },
      });
      const server = createControllerServer({
        secret: SECRET,
        capacity: 2,
        launcher,
        logger: createSilentLogger(),
        skipMeetingUrlCheck: true,
      });
      loop = { app, launcher, server, url: "", runners, createRunnerCalls };
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      loop.url = `http://127.0.0.1:${boundPort(server)}`;
    });

    afterEach(async () => {
      const started = loop;
      loop = null;
      if (!started) return;
      try {
        // Runners must end while the app still answers: a session.ended sent to a closed app is
        // retried for minutes.
        await withTimeout(started.launcher.shutdown(), DONE_TIMEOUT_MS, "launcher shutdown");
      } finally {
        await closeServer(started.server);
        await started.app.close();
      }
    });

    it("delivers a whole fake meeting as five signed events and reports the final state", async () => {
      const { app, url } = currentLoop();
      const sessionId = nextSessionId();

      const reply = await join(joinRequestFor(app, sessionId));

      expect(reply.status).toBe(202);
      expect(notetakerBotJoinResponseSchema.parse(reply.json)).toEqual({
        sessionId,
        externalRef: `in-process-${sessionId}`,
      });

      expect(await doneOf(sessionId)).toEqual({ endReason: "MEETING_ENDED", passageCount: 2 });

      expect(app.requests).toHaveLength(5);
      for (const request of app.requests) {
        expect(request.method).toBe("POST");
        expect(request.path).toBe(EVENTS_PATH);
        expect(isSignedWith(request, SECRET)).toBe(true);
        expect(isSignedWith(request, OTHER_SECRET)).toBe(false);
      }

      const events = parseEvents(app);
      expect(events.map((event) => event.type)).toEqual(FULL_MEETING_TYPES);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events.map((event) => event.sessionId)).toEqual(Array.from({ length: 5 }, () => sessionId));
      expect(new Set(events.map((event) => event.eventId)).size).toBe(5);

      const passagesEvent = events[3];
      if (passagesEvent?.type !== "transcript.passages") throw new Error("The fourth event has no passages");
      const { passages } = passagesEvent.data;
      expect(passages.map((passage) => passage.index)).toEqual([0, 1]);
      expect(passages.filter((passage) => passage.unknownSpeakerNumber === 1)).toHaveLength(1);
      expect(passages.filter((passage) => passage.speakerName === "Fake Participant")).toHaveLength(1);

      const endedEvent = events[4];
      if (endedEvent?.type !== "session.ended") throw new Error("The fifth event is not the end");
      expect(endedEvent.data).toMatchObject({
        endReason: "MEETING_ENDED",
        interruptedAtMs: null,
        passageCount: 2,
      });
      expect(endedEvent.data.durationMs).toBeGreaterThan(0);

      const state = await send(url, { method: "GET", path: sessionPath(sessionId) });
      expect(state.status).toBe(200);
      expect(notetakerBotStateSchema.parse(state.json)).toEqual({
        sessionId,
        phase: "ENDED",
        lastEventSequence: 5,
      });
    });

    it("launches one runner when the same join is repeated", async () => {
      const { app, createRunnerCalls } = currentLoop();
      const sessionId = nextSessionId();
      const request = joinRequestFor(app, sessionId);

      const [first, concurrent] = await Promise.all([join(request), join(request)]);
      const later = await join(request);

      for (const reply of [first, concurrent, later]) {
        expect(reply.status).toBe(202);
        expect(notetakerBotJoinResponseSchema.parse(reply.json)).toEqual({
          sessionId,
          externalRef: `in-process-${sessionId}`,
        });
      }
      expect(createRunnerCalls).toEqual([sessionId]);

      await doneOf(sessionId);
      expect(app.requests).toHaveLength(5);
    });

    it("ends the session once on a signed stop", async () => {
      const { app, url } = currentLoop();
      const sessionId = nextSessionId();
      const stopPath = `${sessionPath(sessionId)}/stop`;

      expect((await join(joinRequestFor(app, sessionId))).status).toBe(202);
      await vi.waitFor(() => expect(eventTypes(app)).toContain("session.admitted"), WAIT_OPTIONS);

      const stopped = await send(url, { method: "POST", path: stopPath, body: STOP_BODY });
      expect(stopped.status).toBe(202);
      expect(stopped.json).toEqual({ sessionId, accepted: true });

      expect((await doneOf(sessionId)).endReason).toBe("STOP_REQUESTED");

      const events = parseEvents(app);
      const last = events.at(-1);
      if (last?.type !== "session.ended") throw new Error("The last event is not the end");
      expect(last.data.endReason).toBe("STOP_REQUESTED");
      expect(events.filter((event) => event.type === "session.ended")).toHaveLength(1);

      const again = await send(url, { method: "POST", path: stopPath, body: STOP_BODY });
      expect(again.status).toBe(202);
    });

    it("sends nothing more after the app answers 410", async () => {
      const { app, url } = currentLoop();
      const sessionId = nextSessionId();
      app.respondWith((_request, index) =>
        index === 0 ? { status: 200, body: '{"ok":true}' } : { status: 410 }
      );

      const joinedAt = Date.now();
      expect((await join(joinRequestFor(app, sessionId))).status).toBe(202);
      expect((await doneOf(sessionId)).endReason).toBeNull();

      // The scripted meeting ends on its own one second after the join; a runner that kept sending
      // would deliver its remaining events by then.
      await sleep(Math.max(0, 1400 - (Date.now() - joinedAt)));

      expect(app.requests).toHaveLength(2);
      expect(eventTypes(app)).not.toContain("session.ended");

      const state = await send(url, { method: "GET", path: sessionPath(sessionId) });
      expect(state.status).toBe(200);
      expect(notetakerBotStateSchema.parse(state.json)).toEqual({
        sessionId,
        phase: "ENDED",
        lastEventSequence: 1,
      });
    });

    it("refuses requests whose signature does not verify", async () => {
      const { app, url, launcher, createRunnerCalls } = currentLoop();
      const sessionId = nextSessionId();
      const body = JSON.stringify(joinRequestFor(app, sessionId));

      const wrongSecret = await send(url, {
        method: "POST",
        path: "/v1/sessions",
        body,
        secret: OTHER_SECRET,
      });
      expect(wrongSecret.status).toBe(401);
      expect(wrongSecret.json).toEqual({ error: "invalid_signature" });

      const stale = await send(url, {
        method: "POST",
        path: "/v1/sessions",
        body,
        timestampSeconds: Math.floor(Date.now() / 1000) - 3600,
      });
      expect(stale.status).toBe(401);

      const unsignedStop = await send(url, {
        method: "POST",
        path: `${sessionPath(sessionId)}/stop`,
        body: STOP_BODY,
        sign: false,
      });
      expect(unsignedStop.status).toBe(401);

      expect(createRunnerCalls).toEqual([]);
      expect(await launcher.countActive()).toBe(0);
      expect(app.requests).toHaveLength(0);
    });
  });

  describe("startController", () => {
    class RecordingLauncher implements MeetingRunnerLauncher {
      launchCalls: NotetakerBotJoinRequest[] = [];
      shutdownCalls = 0;
      shutdownError: Error | null = null;

      async launch(request: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
        this.launchCalls.push(request);
        return { externalRef: `ref-${request.sessionId}` };
      }

      async stop(): Promise<void> {}

      async getStatus(): Promise<RunnerStatus | null> {
        return null;
      }

      async countActive(): Promise<number> {
        return 0;
      }

      async shutdown(): Promise<void> {
        this.shutdownCalls += 1;
        if (this.shutdownError) throw this.shutdownError;
      }
    }

    type Controller = Awaited<ReturnType<typeof startController>>;

    let app: StubHttpServer | null = null;
    let launcher = new RecordingLauncher();
    let controllers: Controller[] = [];

    function currentApp(): StubHttpServer {
      if (!app) throw new Error("The stub app was not started");
      return app;
    }

    function controllerEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      return {
        NOTETAKER_BOT_SECRET: SECRET,
        NOTETAKER_BOT_PORT: "0",
        NOTETAKER_BOT_CAPACITY: "3",
        NOTETAKER_LOG_LEVEL: "silent",
        ...extra,
      };
    }

    async function start(env: NodeJS.ProcessEnv): Promise<Controller> {
      const controller = await withTimeout(startController(env), REQUEST_TIMEOUT_MS, "startController");
      controllers.push(controller);
      return controller;
    }

    function urlOf(controller: Controller): string {
      return `http://127.0.0.1:${boundPort(controller.server)}`;
    }

    beforeEach(async () => {
      launcher = new RecordingLauncher();
      mocks.holder.launcher = launcher;
      mocks.createMeetingRunnerLauncher.mockClear();
      controllers = [];
      app = await startStubHttpServer();
    });

    afterEach(async () => {
      const started = controllers;
      controllers = [];
      try {
        for (const controller of started) {
          await withTimeout(controller.close(), REQUEST_TIMEOUT_MS, "controller close");
        }
      } finally {
        for (const controller of started) {
          if (controller.server.listening) await closeServer(controller.server);
        }
        mocks.holder.launcher = null;
        await app?.close();
        app = null;
      }
    });

    it("listens on loopback with the launcher built from the configuration", async () => {
      const env = controllerEnv();

      const controller = await start(env);

      expect(controller.server.listening).toBe(true);
      const address = controller.server.address();
      if (address === null || typeof address === "string") throw new Error("The controller has no TCP port");
      expect(address.address).toBe("127.0.0.1");

      const health = await send(urlOf(controller), { method: "GET", path: "/healthz", sign: false });
      expect(health.status).toBe(200);
      expect(health.json).toEqual({ ok: true, activeSessions: 0, capacity: 3 });

      expect(mocks.createMeetingRunnerLauncher).toHaveBeenCalledTimes(1);
      const input = mocks.createMeetingRunnerLauncher.mock.calls[0]?.[0];
      if (!input) throw new Error("The launcher factory received no input");
      expect(input.config).toEqual(getControllerConfig(env));
      expect(input.env).toBe(env);
      expect(typeof input.logger.info).toBe("function");
      expect(typeof input.logger.child).toBe("function");
    });

    it("refuses an off-platform link with the default adapter", async () => {
      const controller = await start(controllerEnv());
      const request = joinRequestFor(currentApp(), nextSessionId(), { meetingUrl: OFF_PLATFORM_URL });

      const reply = await send(urlOf(controller), {
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify(request),
      });

      expect(reply.status).toBe(422);
      expect(launcher.launchCalls).toHaveLength(0);
    });

    it("skips the link check with the fake adapter", async () => {
      const controller = await start(controllerEnv({ NOTETAKER_BOT_ADAPTER: "fake" }));
      const request = joinRequestFor(currentApp(), nextSessionId(), { meetingUrl: OFF_PLATFORM_URL });

      const reply = await send(urlOf(controller), {
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify(request),
      });

      expect(reply.status).toBe(202);
      expect(launcher.launchCalls).toEqual([request]);
    });

    it("stops listening and shuts the launcher down once on close", async () => {
      const controller = await start(controllerEnv());

      await withTimeout(controller.close(), REQUEST_TIMEOUT_MS, "first close");

      expect(controller.server.listening).toBe(false);
      expect(launcher.shutdownCalls).toBe(1);

      await expect(
        withTimeout(controller.close(), REQUEST_TIMEOUT_MS, "second close")
      ).resolves.toBeUndefined();
      expect(launcher.shutdownCalls).toBe(1);
    });

    it("closes without rejecting when the launcher fails to shut down", async () => {
      launcher.shutdownError = new Error("shutdown failed");
      const controller = await start(controllerEnv());

      await expect(withTimeout(controller.close(), REQUEST_TIMEOUT_MS, "close")).resolves.toBeUndefined();

      expect(controller.server.listening).toBe(false);
      expect(launcher.shutdownCalls).toBe(1);
    });

    it("rejects without building a launcher when the secret is missing", async () => {
      await expect(start({})).rejects.toThrow("NOTETAKER_BOT_SECRET");

      expect(mocks.createMeetingRunnerLauncher).not.toHaveBeenCalled();
    });

    it("rejects when the port is already in use", async () => {
      const takenPort = new URL(currentApp().url).port;

      await expect(start(controllerEnv({ NOTETAKER_BOT_PORT: takenPort }))).rejects.toThrow();
    });
  });

  describe("runRunner", () => {
    type Run = { lines: string[]; stop(): void; result: Promise<number> };

    let app: StubHttpServer | null = null;
    let runs: Run[] = [];
    let stderrSpy: ReturnType<typeof captureStderr> | null = null;

    function currentApp(): StubHttpServer {
      if (!app) throw new Error("The stub app was not started");
      return app;
    }

    function captureStderr() {
      return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    }

    function stderrText(): string {
      if (!stderrSpy) return "";
      return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    }

    function runnerEnv(request: NotetakerBotJoinRequest): NodeJS.ProcessEnv {
      return {
        NOTETAKER_BOT_SECRET: SECRET,
        NOTETAKER_BOT_ADAPTER: "fake",
        NOTETAKER_FAKE_MEETING_SECONDS: "1",
        NOTETAKER_LOG_LEVEL: "silent",
        [RUNNER_JOIN_REQUEST_ENV]: encodeJoinRequestEnv(request),
      };
    }

    function run(env: NodeJS.ProcessEnv, options: { stopDuringStartUp?: boolean } = {}): Run {
      const lines: string[] = [];
      let stopHandler: () => void = () => {};
      const result = runRunner({
        env,
        writeStatusLine: (line: string) => {
          lines.push(line);
        },
        onStopSignal: (handler: () => void) => {
          stopHandler = handler;
          if (options.stopDuringStartUp) handler();
        },
      });
      const started: Run = {
        lines,
        stop: () => stopHandler(),
        result: withTimeout(result, DONE_TIMEOUT_MS, "runRunner"),
      };
      // A test that fails before awaiting the result must not leave an unhandled rejection behind.
      started.result.catch(() => {});
      runs.push(started);
      return started;
    }

    beforeEach(async () => {
      runs = [];
      stderrSpy = null;
      app = await startStubHttpServer();
    });

    afterEach(async () => {
      const started = runs;
      runs = [];
      try {
        // Runners must end while the app still answers, as in the loop above.
        for (const entry of started) entry.stop();
        await Promise.allSettled(started.map((entry) => entry.result));
      } finally {
        stderrSpy?.mockRestore();
        stderrSpy = null;
        await app?.close();
        app = null;
      }
    });

    it("runs a fake meeting to its end and reports each phase as a status line", async () => {
      const stub = currentApp();
      const { lines, result } = run(runnerEnv(joinRequestFor(stub, nextSessionId())));

      expect(await result).toBe(0);

      const statuses = lines.map((line) => parseRunnerStatusLine(line));
      expect(statuses).not.toContain(null);
      expect(statuses[0]).toEqual({ phase: "STARTING", lastEventSequence: 0 });
      const phases = statuses.map((status) => status?.phase);
      expect(phases.filter((phase, index) => phase !== phases[index - 1])).toEqual([
        "STARTING",
        "WAITING",
        "IN_MEETING",
        "ENDED",
      ]);
      expect(findLastRunnerStatus(lines.join("\n"))).toEqual({ phase: "ENDED", lastEventSequence: 5 });
      expect(eventTypes(stub)).toEqual(FULL_MEETING_TYPES);
    });

    it("ends the session when the stop signal arrives during the meeting", async () => {
      const stub = currentApp();
      const started = run(runnerEnv(joinRequestFor(stub, nextSessionId())));

      await vi.waitFor(() => expect(eventTypes(stub)).toContain("session.admitted"), WAIT_OPTIONS);
      started.stop();

      expect(await started.result).toBe(0);
      const last = parseEvents(stub).at(-1);
      if (last?.type !== "session.ended") throw new Error("The last event is not the end");
      expect(last.data.endReason).toBe("STOP_REQUESTED");
    });

    it("ends the session when the stop signal arrives before start-up finished", async () => {
      const stub = currentApp();
      const started = run(runnerEnv(joinRequestFor(stub, nextSessionId())), { stopDuringStartUp: true });

      expect(await started.result).toBe(0);

      const events = parseEvents(stub);
      const ended = events.filter((event) => event.type === "session.ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]?.data.endReason).toBe("STOP_REQUESTED");
      expect(events.map((event) => event.type)).not.toContain("session.admitted");
    });

    it("exits 1 without a status line when the configuration is invalid", async () => {
      stderrSpy = captureStderr();

      const { lines, result } = run({});

      expect(await result).toBe(1);
      expect(lines).toEqual([]);
      expect(stderrText()).toContain("NOTETAKER_BOT_SECRET");
      expect(currentApp().requests).toHaveLength(0);
    });

    it("exits 1 and names the variable when the join request is missing", async () => {
      stderrSpy = captureStderr();

      const { lines, result } = run({
        NOTETAKER_BOT_SECRET: SECRET,
        NOTETAKER_BOT_ADAPTER: "fake",
        NOTETAKER_LOG_LEVEL: "silent",
      });

      expect(await result).toBe(1);
      expect(lines).toEqual([]);
      expect(stderrText()).toContain(RUNNER_JOIN_REQUEST_ENV);
      expect(currentApp().requests).toHaveLength(0);
    });

    it("keeps the secret out of the status lines and the error output", async () => {
      stderrSpy = captureStderr();
      const env = runnerEnv(joinRequestFor(currentApp(), nextSessionId()));

      const completed = run(env);
      expect(await completed.result).toBe(0);
      // An invalid value next to a set secret: the configuration error must name the variable only.
      const refused = run({ ...env, NOTETAKER_BOT_ADAPTER: "not-an-adapter" });
      expect(await refused.result).toBe(1);

      const output = [...completed.lines, ...refused.lines, stderrText()].join("\n");
      expect(output).toContain("NOTETAKER_BOT_ADAPTER");
      expect(output).not.toContain(SECRET);
    });
  });
});
