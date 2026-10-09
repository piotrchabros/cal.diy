import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotJoinRequestSchema,
  notetakerBotStopRequestSchema,
  verifyNotetakerSignature,
} from "@calcom/lib/notetaker/botContract";
import type { LogFields, Logger } from "./logger";
import { isJoinableMeetingUrl } from "./platform/meetingUrl";
import type {
  MeetingRunnerLauncher,
  RunnerPhase,
  RunnerStatus,
} from "./runner/launcher/MeetingRunnerLauncher";
import { RunnerLaunchError } from "./runner/launcher/MeetingRunnerLauncher";

// Past this size the rest of the body is not worth reading just to deliver a clean 413.
const HARD_BODY_LIMIT_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;
const ENDED_SESSION_RETENTION_MS = 86_400_000;

const ROUTE_HEALTHZ = "GET /healthz";
const ROUTE_JOIN = "POST /v1/sessions";
const ROUTE_STATE = "GET /v1/sessions/:sessionId";
const ROUTE_STOP = "POST /v1/sessions/:sessionId/stop";
const ROUTE_UNMATCHED = "unmatched";
const ROUTE_UNVERIFIED = "unverified";
const ROUTE_OVERSIZED = "oversized";

type RouteName =
  | typeof ROUTE_HEALTHZ
  | typeof ROUTE_JOIN
  | typeof ROUTE_STATE
  | typeof ROUTE_STOP
  | typeof ROUTE_UNMATCHED
  | typeof ROUTE_UNVERIFIED
  | typeof ROUTE_OVERSIZED;

type RouteMatch =
  | { route: typeof ROUTE_JOIN }
  | { route: typeof ROUTE_STATE; sessionId: string }
  | { route: typeof ROUTE_STOP; sessionId: string };

type BodyRead =
  | { kind: "read"; rawBody: string }
  | { kind: "too_large"; drained: boolean }
  | { kind: "aborted" };

type Outcome = {
  route: RouteName;
  status: number;
  body: Record<string, unknown> | null;
  sessionId?: string;
  warn?: boolean;
  message?: string;
  closeConnection?: boolean;
  destroyRequest?: boolean;
};

type SessionEntry = {
  response: Promise<{ externalRef: string }>;
  lastEventSequence: number;
  endedAt: number | null;
};

type ControllerContext = {
  secret: string;
  capacity: number;
  launcher: MeetingRunnerLauncher;
  logger: Logger;
  skipMeetingUrlCheck: boolean;
  now: () => number;
  registry: Map<string, SessionEntry>;
  inFlight: Set<string>;
};

function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    if (Number(req.headers["content-length"]) > HARD_BODY_LIMIT_BYTES) {
      resolve({ kind: "too_large", drained: false });
      return;
    }

    let chunks: Buffer[] = [];
    let total = 0;

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > HARD_BODY_LIMIT_BYTES) {
        req.off("data", onData);
        req.pause();
        resolve({ kind: "too_large", drained: false });
        return;
      }
      if (total > MAX_CONTROL_BODY_BYTES) {
        chunks = [];
        return;
      }
      chunks.push(chunk);
    };

    req.on("data", onData);
    // An oversized body is discarded up to its end before the 413 is written: closing a socket that
    // still holds unread data can reset the connection before the client reads the response.
    req.on("end", () => {
      if (total > MAX_CONTROL_BODY_BYTES) {
        resolve({ kind: "too_large", drained: true });
        return;
      }
      resolve({ kind: "read", rawBody: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => resolve({ kind: "aborted" }));
    req.on("close", () => resolve({ kind: "aborted" }));
  });
}

function readSingleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function decodeSessionId(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function matchRoute(method: string | undefined, path: string): RouteMatch | null {
  const segments = path.split("/");
  if (segments[0] !== "" || segments[1] !== "v1" || segments[2] !== "sessions") return null;
  if (segments.length === 3) return method === "POST" ? { route: ROUTE_JOIN } : null;

  const sessionId = decodeSessionId(segments[3]);
  if (sessionId === null) return null;

  if (segments.length === 4) return method === "GET" ? { route: ROUTE_STATE, sessionId } : null;
  if (segments.length === 5 && segments[4] === "stop") {
    return method === "POST" ? { route: ROUTE_STOP, sessionId } : null;
  }
  return null;
}

function pruneEndedSessions(context: ControllerContext): void {
  const { registry, now } = context;
  const currentTime = now();
  for (const [sessionId, entry] of registry) {
    if (entry.endedAt !== null && currentTime - entry.endedAt > ENDED_SESSION_RETENTION_MS) {
      registry.delete(sessionId);
    }
  }
}

async function admit(
  context: ControllerContext,
  request: NotetakerBotJoinRequest
): Promise<{ externalRef: string }> {
  const { launcher, capacity, inFlight } = context;
  const { sessionId } = request;
  inFlight.add(sessionId);
  try {
    const active = await launcher.countActive();
    // The launcher does not count a runner it has not finished starting, so launches in flight are added here.
    if (active + (inFlight.size - 1) >= capacity) {
      throw new RunnerLaunchError(
        "AT_CAPACITY",
        `Unable to launch a runner: ${active} runners are active and ${inFlight.size - 1} other launches are in flight, capacity is ${capacity}`
      );
    }
    const { externalRef } = await launcher.launch(request);
    if (!externalRef) {
      throw new RunnerLaunchError("FAILED", "The launcher started a runner without an external reference");
    }
    return { externalRef };
  } finally {
    inFlight.delete(sessionId);
  }
}

function createEntry(context: ControllerContext, request: NotetakerBotJoinRequest): SessionEntry {
  const { registry } = context;
  const entry: SessionEntry = { response: admit(context, request), lastEventSequence: 0, endedAt: null };
  registry.set(request.sessionId, entry);
  // A failed launch is forgotten so a later join can launch again. Attaching this handler here also
  // keeps the stored promise from becoming an unhandled rejection when no request is awaiting it.
  entry.response.catch(() => {
    if (registry.get(request.sessionId) === entry) registry.delete(request.sessionId);
  });
  return entry;
}

function recordStatus(entry: SessionEntry | undefined, status: RunnerStatus | null, endedAt: number): void {
  if (!entry) return;
  if (status === null) {
    entry.endedAt ??= endedAt;
    return;
  }
  entry.lastEventSequence = Math.max(entry.lastEventSequence, status.lastEventSequence);
  if (status.phase === "ENDED") entry.endedAt ??= endedAt;
}

async function handleHealthz(context: ControllerContext): Promise<Outcome> {
  const { launcher, capacity } = context;
  try {
    const activeSessions = await launcher.countActive();
    return { route: ROUTE_HEALTHZ, status: 200, body: { ok: true, activeSessions, capacity } };
  } catch {
    return { route: ROUTE_HEALTHZ, status: 503, body: { ok: false } };
  }
}

async function handleJoin(context: ControllerContext, rawBody: string): Promise<Outcome> {
  const parsed = notetakerBotJoinRequestSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) return { route: ROUTE_JOIN, status: 422, body: { error: "invalid_request" } };

  const request = parsed.data;
  const { sessionId } = request;
  if (!context.skipMeetingUrlCheck && !isJoinableMeetingUrl(request.platform, request.meetingUrl)) {
    return { route: ROUTE_JOIN, status: 422, body: { error: "meeting_url_unusable" }, sessionId };
  }

  pruneEndedSessions(context);
  // Lookup and creation stay in one synchronous step so two simultaneous joins launch one runner.
  const entry = context.registry.get(sessionId) ?? createEntry(context, request);

  try {
    const { externalRef } = await entry.response;
    return { route: ROUTE_JOIN, status: 202, body: { sessionId, externalRef }, sessionId };
  } catch (error) {
    if (error instanceof RunnerLaunchError && error.kind === "AT_CAPACITY") {
      return {
        route: ROUTE_JOIN,
        status: 503,
        body: { error: "at_capacity" },
        sessionId,
        warn: true,
        message: "join refused: at capacity",
      };
    }
    return {
      route: ROUTE_JOIN,
      status: 503,
      body: { error: "launch_failed" },
      sessionId,
      message: "join failed: launcher error",
    };
  }
}

async function handleState(context: ControllerContext, sessionId: string): Promise<Outcome> {
  const { launcher, registry, inFlight, now } = context;
  const stateOutcome = (phase: RunnerPhase, lastEventSequence: number): Outcome => ({
    route: ROUTE_STATE,
    status: 200,
    body: { sessionId, phase, lastEventSequence },
    sessionId,
  });

  const entry = registry.get(sessionId);
  // The launcher knows nothing about a runner it is still starting, and asking it would report the session as ended.
  if (entry && inFlight.has(sessionId)) return stateOutcome("STARTING", entry.lastEventSequence);

  let status: RunnerStatus | null;
  try {
    status = await launcher.getStatus(sessionId);
  } catch {
    return { route: ROUTE_STATE, status: 503, body: { error: "launcher_unavailable" }, sessionId };
  }

  recordStatus(entry, status, now());
  if (status !== null) {
    return stateOutcome(status.phase, entry ? entry.lastEventSequence : status.lastEventSequence);
  }
  if (entry) return stateOutcome("ENDED", entry.lastEventSequence);
  return { route: ROUTE_STATE, status: 404, body: null, sessionId };
}

async function handleStop(context: ControllerContext, sessionId: string, rawBody: string): Promise<Outcome> {
  const { launcher, registry, inFlight, now } = context;
  if (!notetakerBotStopRequestSchema.safeParse(parseJson(rawBody)).success) {
    return { route: ROUTE_STOP, status: 400, body: { error: "invalid_request" }, sessionId };
  }

  const entry = registry.get(sessionId);
  if (entry && inFlight.has(sessionId)) {
    try {
      await entry.response;
    } catch {
      return { route: ROUTE_STOP, status: 404, body: null, sessionId };
    }
  }

  try {
    const status = await launcher.getStatus(sessionId);
    if (!entry && status === null) return { route: ROUTE_STOP, status: 404, body: null, sessionId };

    recordStatus(entry, status, now());
    if (status !== null && status.phase !== "ENDED") await launcher.stop(sessionId);
  } catch {
    return { route: ROUTE_STOP, status: 503, body: { error: "launcher_unavailable" }, sessionId };
  }

  return { route: ROUTE_STOP, status: 202, body: { sessionId, accepted: true }, sessionId };
}

async function handleRoute(context: ControllerContext, match: RouteMatch, rawBody: string): Promise<Outcome> {
  try {
    if (match.route === ROUTE_JOIN) return await handleJoin(context, rawBody);
    if (match.route === ROUTE_STATE) return await handleState(context, match.sessionId);
    return await handleStop(context, match.sessionId, rawBody);
  } catch {
    return { route: match.route, status: 500, body: { error: "internal_error" } };
  }
}

async function resolveOutcome(context: ControllerContext, req: IncomingMessage): Promise<Outcome | null> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && path === "/healthz") {
    req.resume();
    return handleHealthz(context);
  }

  const bodyRead = await readBody(req);
  if (bodyRead.kind === "aborted") return null;
  if (bodyRead.kind === "too_large") {
    return {
      route: ROUTE_OVERSIZED,
      status: 413,
      body: { error: "body_too_large" },
      closeConnection: true,
      destroyRequest: !bodyRead.drained,
    };
  }

  const rawBody = req.method === "GET" ? "" : bodyRead.rawBody;
  const verified = verifyNotetakerSignature({
    secret: context.secret,
    timestamp: readSingleHeader(req, NOTETAKER_TIMESTAMP_HEADER),
    signature: readSingleHeader(req, NOTETAKER_SIGNATURE_HEADER),
    rawBody,
    nowSeconds: Math.floor(context.now() / 1000),
  });
  if (!verified) return { route: ROUTE_UNVERIFIED, status: 401, body: { error: "invalid_signature" } };

  const match = matchRoute(req.method, path);
  if (!match) return { route: ROUTE_UNMATCHED, status: 404, body: null };

  return handleRoute(context, match, rawBody);
}

function logOutcome(logger: Logger, outcome: Outcome): void {
  const fields: LogFields = { route: outcome.route, status: outcome.status };
  if (outcome.sessionId !== undefined) fields.sessionId = outcome.sessionId;
  const message = outcome.message ?? "control request";

  if (outcome.warn) {
    logger.warn(message, fields);
    return;
  }
  if (outcome.status >= 500) {
    logger.error(message, fields);
    return;
  }
  if (outcome.route === ROUTE_HEALTHZ) {
    logger.debug(message, fields);
    return;
  }
  logger.info(message, fields);
}

function sendOutcome(logger: Logger, req: IncomingMessage, res: ServerResponse, outcome: Outcome): void {
  const payload = outcome.body === null ? "" : JSON.stringify(outcome.body);
  const headers: OutgoingHttpHeaders = { "content-length": Buffer.byteLength(payload) };
  if (outcome.body !== null) headers["content-type"] = "application/json";
  if (outcome.closeConnection) headers.connection = "close";
  if (outcome.destroyRequest) res.once("finish", () => req.destroy());

  res.writeHead(outcome.status, headers);
  res.end(payload);
  logOutcome(logger, outcome);
}

async function handleRequest(
  context: ControllerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const outcome = await resolveOutcome(context, req);
  if (outcome === null) {
    req.destroy();
    return;
  }
  sendOutcome(context.logger, req, res, outcome);
}

export const MAX_CONTROL_BODY_BYTES = 65536;

export type ControllerServerDeps = {
  secret: string;
  capacity: number;
  launcher: MeetingRunnerLauncher;
  logger: Logger;
  skipMeetingUrlCheck?: boolean;
  now?: () => number;
};

export function createControllerServer(deps: ControllerServerDeps): Server {
  // One registry per server: the context is the only place session state lives.
  const context: ControllerContext = {
    secret: deps.secret,
    capacity: deps.capacity,
    launcher: deps.launcher,
    logger: deps.logger,
    skipMeetingUrlCheck: deps.skipMeetingUrlCheck ?? false,
    now: deps.now ?? Date.now,
    registry: new Map<string, SessionEntry>(),
    inFlight: new Set<string>(),
  };

  const server = createServer((req, res) => {
    handleRequest(context, req, res).catch(() => {
      if (res.headersSent) {
        req.socket.destroy();
        return;
      }
      try {
        sendOutcome(context.logger, req, res, {
          route: ROUTE_UNMATCHED,
          status: 500,
          body: { error: "internal_error" },
        });
      } catch {
        req.socket.destroy();
      }
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  return server;
}
