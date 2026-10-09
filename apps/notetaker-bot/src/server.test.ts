// @vitest-environment node
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { NOTETAKER_SIGNATURE_HEADER, NOTETAKER_TIMESTAMP_HEADER } from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";
import type { MeetingRunnerLauncher, RunnerStatus } from "./runner/launcher/MeetingRunnerLauncher";
import { RunnerLaunchError } from "./runner/launcher/MeetingRunnerLauncher";
import type { ControllerServerDeps } from "./server";
import { createControllerServer, MAX_CONTROL_BODY_BYTES } from "./server";
import { buildJoinRequest, buildSignedHeaders, useRealFetch } from "./testing/httpTestKit";

const SECRET = "test-secret-not-real";
const OTHER_SECRET = "another-test-secret-not-real";
const START_MS = Date.parse("2030-01-01T09:55:00.000Z");
const DAY_MS = 86_400_000;
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const OFF_PLATFORM_URL = "https://meet.example.test/abc-defg-hij";
const STOP_BODY = JSON.stringify({ reason: "STOPPED_BY_HOST" });

type LaunchResult = { externalRef: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RecordingLauncher implements MeetingRunnerLauncher {
  launchCalls: NotetakerBotJoinRequest[] = [];
  stopCalls: string[] = [];
  statusCalls: string[] = [];
  countCalls = 0;
  shutdownCalls = 0;

  statuses = new Map<string, RunnerStatus | null>();
  activeCount = 0;
  launchResult: (request: NotetakerBotJoinRequest) => Promise<LaunchResult> = () =>
    Promise.resolve({ externalRef: `ref-${this.launchCalls.length}` });
  countError: Error | null = null;
  statusError: Error | null = null;
  stopError: Error | null = null;

  async launch(request: NotetakerBotJoinRequest): Promise<LaunchResult> {
    this.launchCalls.push(request);
    return this.launchResult(request);
  }

  async stop(sessionId: string): Promise<void> {
    this.stopCalls.push(sessionId);
    if (this.stopError) throw this.stopError;
  }

  async getStatus(sessionId: string): Promise<RunnerStatus | null> {
    this.statusCalls.push(sessionId);
    if (this.statusError) throw this.statusError;
    return this.statuses.get(sessionId) ?? null;
  }

  async countActive(): Promise<number> {
    this.countCalls += 1;
    if (this.countError) throw this.countError;
    return this.activeCount;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

type SendOptions = {
  method: "GET" | "POST";
  path: string;
  body?: string;
  sign?: boolean;
  secret?: string;
  signedBody?: string;
  timestampSeconds?: number;
  headers?: Record<string, string>;
};

type Reply = { status: number; headers: Headers; text: string };

type RawReply = { status: number; headers: IncomingHttpHeaders; text: string };

type Harness = {
  launcher: RecordingLauncher;
  lines: string[];
  port: number;
  send(options: SendOptions): Promise<Reply>;
  join(request?: NotetakerBotJoinRequest): Promise<Reply>;
  state(sessionId: string): Promise<Reply>;
  stop(sessionId: string, body?: string): Promise<Reply>;
};

const parseJson = (text: string): unknown => JSON.parse(text);

const sessionPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}`;

describe("controller server", () => {
  useRealFetch();

  let nowMs = START_MS;
  let servers: Server[] = [];

  beforeEach(() => {
    nowMs = START_MS;
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          })
      )
    );
  });

  async function start(
    overrides: Partial<Pick<ControllerServerDeps, "capacity" | "skipMeetingUrlCheck">> = {}
  ): Promise<Harness> {
    const launcher = new RecordingLauncher();
    const lines: string[] = [];
    const server = createControllerServer({
      secret: SECRET,
      capacity: 10,
      launcher,
      logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      now: () => nowMs,
      ...overrides,
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`Controller server did not bind to a TCP port, address was ${String(address)}`);
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const send = async (options: SendOptions): Promise<Reply> => {
      const signed =
        options.sign === false
          ? {}
          : buildSignedHeaders({
              secret: options.secret ?? SECRET,
              rawBody: options.signedBody ?? options.body ?? "",
              timestampSeconds: options.timestampSeconds ?? Math.floor(nowMs / 1000),
            });
      const contentType: Record<string, string> =
        options.body === undefined ? {} : { "content-type": "application/json" };
      const response = await fetch(`${baseUrl}${options.path}`, {
        method: options.method,
        headers: { ...contentType, ...signed, ...options.headers },
        body: options.body,
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };

    return {
      launcher,
      lines,
      port: address.port,
      send,
      join: (request = buildJoinRequest()) =>
        send({ method: "POST", path: "/v1/sessions", body: JSON.stringify(request) }),
      state: (sessionId) => send({ method: "GET", path: sessionPath(sessionId) }),
      stop: (sessionId, body = STOP_BODY) =>
        send({ method: "POST", path: `${sessionPath(sessionId)}/stop`, body }),
    };
  }

  // fetch hides whether the server asked to close the connection on some runtimes, so the oversized
  // case reads the response headers from node:http directly.
  function rawPost(port: number, path: string, body: string): Promise<RawReply> {
    return new Promise<RawReply>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          agent: false,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  function expectNoLauncherCalls(launcher: RecordingLauncher): void {
    expect(launcher.launchCalls).toEqual([]);
    expect(launcher.stopCalls).toEqual([]);
    expect(launcher.statusCalls).toEqual([]);
    expect(launcher.countCalls).toBe(0);
    expect(launcher.shutdownCalls).toBe(0);
  }

  describe("healthz", () => {
    it("healthz answers unsigned with counts only", async () => {
      const { launcher, send } = await start();
      launcher.activeCount = 3;

      const reply = await send({ method: "GET", path: "/healthz", sign: false });

      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toBe("application/json");
      expect(parseJson(reply.text)).toEqual({ ok: true, activeSessions: 3, capacity: 10 });
    });

    it("healthz answers 503 when the launcher cannot count", async () => {
      const { launcher, send } = await start();
      launcher.countError = new Error("launcher is down");

      const reply = await send({ method: "GET", path: "/healthz", sign: false });

      expect(reply.status).toBe(503);
      expect(parseJson(reply.text)).toEqual({ ok: false });
    });

    it("a signed POST to /healthz is not the probe", async () => {
      const { send } = await start();

      const signed = await send({ method: "POST", path: "/healthz" });
      const unsigned = await send({ method: "POST", path: "/healthz", sign: false });

      expect(signed.status).toBe(404);
      expect(unsigned.status).toBe(401);
    });
  });

  describe("join", () => {
    it("join answers 202 and launches one runner", async () => {
      const { launcher, join } = await start();
      const request = buildJoinRequest();

      const reply = await join(request);

      expect(reply.status).toBe(202);
      expect(reply.headers.get("content-type")).toBe("application/json");
      expect(parseJson(reply.text)).toEqual({ sessionId: request.sessionId, externalRef: "ref-1" });
      expect(launcher.launchCalls).toEqual([request]);
    });

    it("a repeated join returns the same body and launches nothing", async () => {
      const { launcher, join } = await start();

      const first = await join();
      const second = await join();

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(parseJson(second.text)).toEqual(parseJson(first.text));
      expect(parseJson(second.text)).toEqual({ sessionId: SESSION_ID, externalRef: "ref-1" });
      expect(launcher.launchCalls).toHaveLength(1);
    });

    it("a repeated join with a different body still returns the stored body", async () => {
      const { launcher, join } = await start();
      const original = buildJoinRequest();

      const first = await join(original);
      const second = await join(buildJoinRequest({ displayName: "Another Notetaker Name" }));

      expect(second.status).toBe(202);
      expect(parseJson(second.text)).toEqual(parseJson(first.text));
      expect(launcher.launchCalls).toEqual([original]);
    });

    it("two simultaneous joins for one session launch one runner", async () => {
      const { launcher, join, state } = await start();
      const launch = createDeferred<LaunchResult>();
      launcher.launchResult = () => launch.promise;

      const replies = Promise.all([join(), join()]);
      await vi.waitFor(() => expect(launcher.launchCalls).toHaveLength(1));
      // A full round trip issued after both joins gives the second one time to reach the server
      // before the launch settles.
      await state(SESSION_ID);
      launch.resolve({ externalRef: "ref-1" });
      const [first, second] = await replies;

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(parseJson(first.text)).toEqual({ sessionId: SESSION_ID, externalRef: "ref-1" });
      expect(parseJson(second.text)).toEqual({ sessionId: SESSION_ID, externalRef: "ref-1" });
      expect(launcher.launchCalls).toHaveLength(1);
    });

    it("join answers 422 for a body that is not JSON", async () => {
      const { launcher, send } = await start();

      const reply = await send({ method: "POST", path: "/v1/sessions", body: "not json" });

      expect(reply.status).toBe(422);
      expect(parseJson(reply.text)).toEqual({ error: "invalid_request" });
      expect(launcher.launchCalls).toEqual([]);
    });

    it("join answers 422 for a body that fails the schema", async () => {
      const { launcher, send, join } = await start();

      const badUrl = await join(buildJoinRequest({ meetingUrl: "nope" }));
      const missingLimits = await send({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ ...buildJoinRequest(), limits: undefined }),
      });

      expect(badUrl.status).toBe(422);
      expect(parseJson(badUrl.text)).toEqual({ error: "invalid_request" });
      expect(missingLimits.status).toBe(422);
      expect(parseJson(missingLimits.text)).toEqual({ error: "invalid_request" });
      expect(launcher.launchCalls).toEqual([]);
    });

    it("join answers 422 for a meeting URL on another host", async () => {
      const { launcher, join } = await start();

      const reply = await join(buildJoinRequest({ meetingUrl: OFF_PLATFORM_URL }));

      expect(reply.status).toBe(422);
      expect(parseJson(reply.text)).toEqual({ error: "meeting_url_unusable" });
      expect(launcher.launchCalls).toEqual([]);
    });

    it("skipMeetingUrlCheck accepts any valid URL", async () => {
      const { launcher, join } = await start({ skipMeetingUrlCheck: true });

      const reply = await join(buildJoinRequest({ meetingUrl: OFF_PLATFORM_URL }));

      expect(reply.status).toBe(202);
      expect(launcher.launchCalls).toHaveLength(1);
    });

    it("join answers 503 at capacity", async () => {
      const { launcher, join } = await start();
      launcher.activeCount = 10;

      const reply = await join();

      expect(reply.status).toBe(503);
      expect(parseJson(reply.text)).toEqual({ error: "at_capacity" });
      expect(launcher.launchCalls).toEqual([]);
    });

    it("a join refused at capacity is forgotten", async () => {
      const { launcher, join } = await start();
      launcher.activeCount = 10;
      const refused = await join();
      launcher.activeCount = 9;

      const accepted = await join();

      expect(refused.status).toBe(503);
      expect(accepted.status).toBe(202);
      expect(launcher.launchCalls).toHaveLength(1);
    });

    it("a launch in flight counts towards capacity", async () => {
      const { launcher, join } = await start({ capacity: 1 });
      const launch = createDeferred<LaunchResult>();
      launcher.launchResult = () => launch.promise;

      const pending = join(buildJoinRequest({ sessionId: SESSION_ID }));
      await vi.waitFor(() => expect(launcher.launchCalls).toHaveLength(1));
      const refused = await join(buildJoinRequest({ sessionId: OTHER_SESSION_ID }));
      launch.resolve({ externalRef: "ref-1" });
      const accepted = await pending;

      expect(refused.status).toBe(503);
      expect(parseJson(refused.text)).toEqual({ error: "at_capacity" });
      expect(accepted.status).toBe(202);
      expect(parseJson(accepted.text)).toEqual({ sessionId: SESSION_ID, externalRef: "ref-1" });
      expect(launcher.launchCalls).toHaveLength(1);
    });

    it("join answers 503 when the launcher reports capacity", async () => {
      const { launcher, join } = await start();
      launcher.launchResult = () =>
        Promise.reject(new RunnerLaunchError("AT_CAPACITY", "no runner slot is free"));

      const reply = await join();

      expect(reply.status).toBe(503);
      expect(parseJson(reply.text)).toEqual({ error: "at_capacity" });
    });

    it("join answers 503 when the launch fails and forgets the session", async () => {
      const { launcher, join, state } = await start();
      launcher.launchResult = () =>
        launcher.launchCalls.length === 1
          ? Promise.reject(new Error("the runner process could not be started"))
          : Promise.resolve({ externalRef: "ref-2" });

      const failed = await join();
      const afterFailure = await state(SESSION_ID);
      const retried = await join();

      expect(failed.status).toBe(503);
      expect(parseJson(failed.text)).toEqual({ error: "launch_failed" });
      expect(afterFailure.status).toBe(404);
      expect(retried.status).toBe(202);
      expect(parseJson(retried.text)).toEqual({ sessionId: SESSION_ID, externalRef: "ref-2" });
      expect(launcher.launchCalls).toHaveLength(2);
    });

    it("join answers 503 for an empty external reference", async () => {
      const { launcher, join } = await start();
      launcher.launchResult = () =>
        Promise.resolve({ externalRef: launcher.launchCalls.length === 1 ? "" : "ref-2" });

      const failed = await join();
      const retried = await join();

      expect(failed.status).toBe(503);
      expect(parseJson(failed.text)).toEqual({ error: "launch_failed" });
      expect(retried.status).toBe(202);
      expect(parseJson(retried.text)).toEqual({ sessionId: SESSION_ID, externalRef: "ref-2" });
      expect(launcher.launchCalls).toHaveLength(2);
    });
  });

  describe("signature", () => {
    it("an unsigned request answers 401 and launches nothing", async () => {
      const { launcher, send } = await start();

      const reply = await send({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify(buildJoinRequest()),
        sign: false,
      });

      expect(reply.status).toBe(401);
      expect(reply.headers.get("content-type")).toBe("application/json");
      expect(parseJson(reply.text)).toEqual({ error: "invalid_signature" });
      expectNoLauncherCalls(launcher);
    });

    it("a wrong secret answers 401", async () => {
      const { launcher, send } = await start();

      const reply = await send({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify(buildJoinRequest()),
        secret: OTHER_SECRET,
      });

      expect(reply.status).toBe(401);
      expect(parseJson(reply.text)).toEqual({ error: "invalid_signature" });
      expect(launcher.launchCalls).toEqual([]);
    });

    it("a signature over a different body answers 401", async () => {
      const { launcher, send } = await start();

      const reply = await send({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify(buildJoinRequest({ sessionId: OTHER_SESSION_ID })),
        signedBody: JSON.stringify(buildJoinRequest()),
      });

      expect(reply.status).toBe(401);
      expect(parseJson(reply.text)).toEqual({ error: "invalid_signature" });
      expect(launcher.launchCalls).toEqual([]);
    });

    it("a stale or future timestamp answers 401", async () => {
      const { launcher, send } = await start();
      const nowSeconds = Math.floor(nowMs / 1000);
      const body = JSON.stringify(buildJoinRequest());

      const stale = await send({
        method: "POST",
        path: "/v1/sessions",
        body,
        timestampSeconds: nowSeconds - 301,
      });
      const future = await send({
        method: "POST",
        path: "/v1/sessions",
        body,
        timestampSeconds: nowSeconds + 301,
      });

      expect(stale.status).toBe(401);
      expect(parseJson(stale.text)).toEqual({ error: "invalid_signature" });
      expect(future.status).toBe(401);
      expect(parseJson(future.text)).toEqual({ error: "invalid_signature" });
      expect(launcher.launchCalls).toEqual([]);

      const withinTolerance = await send({
        method: "POST",
        path: "/v1/sessions",
        body,
        timestampSeconds: nowSeconds - 200,
      });

      expect(withinTolerance.status).toBe(202);
    });

    it("a malformed signature header answers 401", async () => {
      const { launcher, send } = await start();
      const body = JSON.stringify(buildJoinRequest());

      const badSignature = await send({
        method: "POST",
        path: "/v1/sessions",
        body,
        headers: { [NOTETAKER_SIGNATURE_HEADER]: "sha256=xyz" },
      });
      const badTimestamp = await send({
        method: "POST",
        path: "/v1/sessions",
        body,
        headers: { [NOTETAKER_TIMESTAMP_HEADER]: "abc" },
      });

      expect(badSignature.status).toBe(401);
      expect(parseJson(badSignature.text)).toEqual({ error: "invalid_signature" });
      expect(badTimestamp.status).toBe(401);
      expect(parseJson(badTimestamp.text)).toEqual({ error: "invalid_signature" });
      expect(launcher.launchCalls).toEqual([]);
    });
  });

  describe("routing", () => {
    it("an unsigned request to an unknown path answers 401, a signed one 404", async () => {
      const { send } = await start();

      const unsigned = await send({ method: "GET", path: "/v1/nope", sign: false });
      const signed = await send({ method: "GET", path: "/v1/nope" });

      expect(unsigned.status).toBe(401);
      expect(signed.status).toBe(404);
      expect(signed.text).toBe("");
      expect(signed.headers.get("content-length")).toBe("0");
    });

    it("unknown methods and trailing slashes answer 404 when signed", async () => {
      const { launcher, send } = await start();

      const getCollection = await send({ method: "GET", path: "/v1/sessions" });
      const postSession = await send({ method: "POST", path: "/v1/sessions/x" });
      const trailingSlash = await send({ method: "GET", path: "/v1/sessions/x/" });

      expect(getCollection.status).toBe(404);
      expect(postSession.status).toBe(404);
      expect(trailingSlash.status).toBe(404);
      expect(launcher.launchCalls).toEqual([]);
    });

    it("the session id in the path is URL-decoded", async () => {
      const { launcher, join, send } = await start();
      const sessionId = "a b/c";
      await join(buildJoinRequest({ sessionId }));
      launcher.statuses.set(sessionId, { phase: "IN_MEETING", lastEventSequence: 2 });

      const reply = await send({ method: "GET", path: `/v1/sessions/${encodeURIComponent(sessionId)}` });

      expect(reply.status).toBe(200);
      expect(parseJson(reply.text)).toEqual({ sessionId, phase: "IN_MEETING", lastEventSequence: 2 });
      expect(launcher.statusCalls).toEqual([sessionId]);
    });

    it("an undecodable session id answers 404", async () => {
      const { send } = await start();

      const reply = await send({ method: "GET", path: "/v1/sessions/%E0%A4%A" });

      expect(reply.status).toBe(404);
      expect(reply.text).toBe("");
    });
  });

  describe("body size", () => {
    it("a body over the limit answers 413 and closes the connection", async () => {
      const { launcher, port } = await start();

      const reply = await rawPost(port, "/v1/sessions", "a".repeat(MAX_CONTROL_BODY_BYTES + 1));

      expect(MAX_CONTROL_BODY_BYTES).toBe(65536);
      expect(reply.status).toBe(413);
      expect(reply.headers.connection).toBe("close");
      expect(parseJson(reply.text)).toEqual({ error: "body_too_large" });
      expectNoLauncherCalls(launcher);
    });

    it("a body of exactly the limit is read", async () => {
      const { send } = await start();

      const reply = await send({
        method: "POST",
        path: "/v1/sessions",
        body: "a".repeat(MAX_CONTROL_BODY_BYTES),
      });

      expect(reply.status).toBe(422);
      expect(parseJson(reply.text)).toEqual({ error: "invalid_request" });
    });
  });

  describe("stop", () => {
    it("stop answers 202 and stops a running session", async () => {
      const { launcher, join, stop } = await start();
      await join();
      launcher.statuses.set(SESSION_ID, { phase: "IN_MEETING", lastEventSequence: 3 });

      const reply = await stop(SESSION_ID);

      expect(reply.status).toBe(202);
      expect(parseJson(reply.text)).toEqual({ sessionId: SESSION_ID, accepted: true });
      expect(launcher.stopCalls).toEqual([SESSION_ID]);
    });

    it("stop answers 202 for an ended session without calling stop", async () => {
      const { launcher, join, stop } = await start();
      await join(buildJoinRequest({ sessionId: SESSION_ID }));
      await join(buildJoinRequest({ sessionId: OTHER_SESSION_ID }));
      launcher.statuses.set(SESSION_ID, { phase: "ENDED", lastEventSequence: 9 });
      launcher.statuses.set(OTHER_SESSION_ID, null);

      const ended = await stop(SESSION_ID);
      const forgottenByLauncher = await stop(OTHER_SESSION_ID);

      expect(ended.status).toBe(202);
      expect(parseJson(ended.text)).toEqual({ sessionId: SESSION_ID, accepted: true });
      expect(forgottenByLauncher.status).toBe(202);
      expect(parseJson(forgottenByLauncher.text)).toEqual({ sessionId: OTHER_SESSION_ID, accepted: true });
      expect(launcher.stopCalls).toEqual([]);
    });

    it("stop reaches a runner the registry does not know", async () => {
      const { launcher, stop } = await start();
      launcher.statuses.set(SESSION_ID, { phase: "IN_MEETING", lastEventSequence: 4 });

      const reply = await stop(SESSION_ID);

      expect(reply.status).toBe(202);
      expect(parseJson(reply.text)).toEqual({ sessionId: SESSION_ID, accepted: true });
      expect(launcher.stopCalls).toEqual([SESSION_ID]);
    });

    it("stop answers 404 for an unknown session", async () => {
      const { launcher, stop } = await start();

      const reply = await stop(SESSION_ID);

      expect(reply.status).toBe(404);
      expect(reply.text).toBe("");
      expect(launcher.stopCalls).toEqual([]);
    });

    it("stop answers 400 for an invalid body", async () => {
      const { launcher, join, stop } = await start();
      await join();
      launcher.statuses.set(SESSION_ID, { phase: "IN_MEETING", lastEventSequence: 3 });

      const unknownReason = await stop(SESSION_ID, JSON.stringify({ reason: "NOPE" }));
      const notJson = await stop(SESSION_ID, "not json");

      expect(unknownReason.status).toBe(400);
      expect(parseJson(unknownReason.text)).toEqual({ error: "invalid_request" });
      expect(notJson.status).toBe(400);
      expect(parseJson(notJson.text)).toEqual({ error: "invalid_request" });
      expect(launcher.stopCalls).toEqual([]);
    });

    it("stop answers 503 when the launcher fails", async () => {
      const { launcher, join, stop } = await start();
      await join();
      launcher.statuses.set(SESSION_ID, { phase: "IN_MEETING", lastEventSequence: 3 });

      launcher.stopError = new Error("the stop could not be delivered");
      const stopFailed = await stop(SESSION_ID);
      launcher.stopError = null;
      launcher.statusError = new Error("the status could not be read");
      const statusFailed = await stop(SESSION_ID);

      expect(stopFailed.status).toBe(503);
      expect(parseJson(stopFailed.text)).toEqual({ error: "launcher_unavailable" });
      expect(statusFailed.status).toBe(503);
      expect(parseJson(statusFailed.text)).toEqual({ error: "launcher_unavailable" });
    });
  });

  describe("state", () => {
    it("state returns the launcher's phase and sequence", async () => {
      const { launcher, join, state } = await start();
      await join();
      launcher.statuses.set(SESSION_ID, { phase: "IN_MEETING", lastEventSequence: 7 });

      const reply = await state(SESSION_ID);

      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toBe("application/json");
      expect(parseJson(reply.text)).toEqual({
        sessionId: SESSION_ID,
        phase: "IN_MEETING",
        lastEventSequence: 7,
      });
    });

    it("state answers STARTING while the launch is in flight", async () => {
      const { launcher, join, state } = await start();
      const launch = createDeferred<LaunchResult>();
      launcher.launchResult = () => launch.promise;
      const pending = join();
      await vi.waitFor(() => expect(launcher.launchCalls).toHaveLength(1));

      const reply = await state(SESSION_ID);

      expect(reply.status).toBe(200);
      expect(parseJson(reply.text)).toEqual({
        sessionId: SESSION_ID,
        phase: "STARTING",
        lastEventSequence: 0,
      });
      expect(launcher.statusCalls).toEqual([]);

      launch.resolve({ externalRef: "ref-1" });
      expect((await pending).status).toBe(202);
    });

    it("state answers ENDED with the last sequence once the launcher forgets the session", async () => {
      const { launcher, join, state } = await start();
      await join();
      launcher.statuses.set(SESSION_ID, { phase: "IN_MEETING", lastEventSequence: 7 });
      await state(SESSION_ID);
      launcher.statuses.set(SESSION_ID, null);

      const reply = await state(SESSION_ID);

      expect(reply.status).toBe(200);
      expect(parseJson(reply.text)).toEqual({ sessionId: SESSION_ID, phase: "ENDED", lastEventSequence: 7 });
    });

    it("state answers 404 for an unknown session", async () => {
      const { state } = await start();

      const reply = await state(SESSION_ID);

      expect(reply.status).toBe(404);
      expect(reply.text).toBe("");
    });

    it("state answers 503 when the launcher fails", async () => {
      const { launcher, join, state } = await start();
      await join();
      launcher.statusError = new Error("the status could not be read");

      const reply = await state(SESSION_ID);

      expect(reply.status).toBe(503);
      expect(parseJson(reply.text)).toEqual({ error: "launcher_unavailable" });
    });
  });

  describe("retention", () => {
    it("ended sessions are forgotten after 24 hours", async () => {
      const { join, state } = await start();
      await join(buildJoinRequest({ sessionId: SESSION_ID }));
      const ended = await state(SESSION_ID);

      nowMs += DAY_MS + 1;
      const other = await join(buildJoinRequest({ sessionId: OTHER_SESSION_ID }));
      const afterPrune = await state(SESSION_ID);

      expect(ended.status).toBe(200);
      expect(parseJson(ended.text)).toEqual({ sessionId: SESSION_ID, phase: "ENDED", lastEventSequence: 0 });
      expect(other.status).toBe(202);
      expect(afterPrune.status).toBe(404);
    });

    it("ended sessions are kept within 24 hours", async () => {
      const { join, state } = await start();
      await join(buildJoinRequest({ sessionId: SESSION_ID }));
      await state(SESSION_ID);

      nowMs += 86_399_000;
      const other = await join(buildJoinRequest({ sessionId: OTHER_SESSION_ID }));
      const afterPrune = await state(SESSION_ID);

      expect(other.status).toBe(202);
      expect(afterPrune.status).toBe(200);
      expect(parseJson(afterPrune.text)).toEqual({
        sessionId: SESSION_ID,
        phase: "ENDED",
        lastEventSequence: 0,
      });
    });
  });

  describe("logging", () => {
    it("logs only the route, status and session id", async () => {
      const { launcher, lines, join, send, state } = await start();
      const request = buildJoinRequest();
      const rawBody = JSON.stringify(request);
      const signature = buildSignedHeaders({
        secret: SECRET,
        rawBody,
        timestampSeconds: Math.floor(nowMs / 1000),
      })[NOTETAKER_SIGNATURE_HEADER];

      await join(request);
      await send({ method: "POST", path: "/v1/sessions", body: rawBody, sign: false });
      await join(buildJoinRequest({ sessionId: OTHER_SESSION_ID, meetingUrl: OFF_PLATFORM_URL }));
      launcher.statuses.set(request.sessionId, { phase: "IN_MEETING", lastEventSequence: 1 });
      await state(request.sessionId);

      const allowedKeys = ["level", "time", "message", "route", "status", "sessionId"];
      const entries = lines.map((line): Record<string, unknown> => JSON.parse(line));
      const byStatus = (status: number) => entries.filter((entry) => entry.status === status);

      expect(typeof signature).toBe("string");
      expect(entries).toHaveLength(4);
      for (const entry of entries) {
        for (const key of Object.keys(entry)) {
          expect(allowedKeys).toContain(key);
        }
      }
      for (const line of lines) {
        expect(line).not.toContain(SECRET);
        expect(line).not.toContain(request.meetingUrl);
        expect(line).not.toContain(OFF_PLATFORM_URL);
        expect(line).not.toContain(request.displayName);
        expect(line).not.toContain(request.noticeMessage);
        expect(line).not.toContain(signature);
        expect(line).not.toContain("ref-1");
      }

      expect(byStatus(202)).toEqual([
        expect.objectContaining({ route: "POST /v1/sessions", status: 202, sessionId: request.sessionId }),
      ]);
      expect(byStatus(200)).toEqual([
        expect.objectContaining({
          route: "GET /v1/sessions/:sessionId",
          status: 200,
          sessionId: request.sessionId,
        }),
      ]);
      expect(byStatus(422)).toEqual([expect.objectContaining({ route: "POST /v1/sessions", status: 422 })]);
      expect(byStatus(401)).toEqual([expect.objectContaining({ route: "unverified", status: 401 })]);
      expect(byStatus(401)[0]).not.toHaveProperty("sessionId");
    });
  });
});
