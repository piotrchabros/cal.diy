import type { IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type {
  AgentBrowserAction,
  AgentBrowserErrorCode,
  AgentBrowserPageState,
} from "@calcom/lib/agentBrowser/contract";
import {
  agentBrowserActionSchema,
  agentBrowserBotIdSchema,
  verifyAgentBrowserAuthorization,
} from "@calcom/lib/agentBrowser/contract";
import type { LogFields, Logger } from "../logger";
import { AgentBrowserActionError } from "../sessions/IBrowserDriver";
import type { SessionManager } from "../sessions/SessionManager";
import type { ViewerHub } from "../viewer/ViewerHub";

const MAX_CONTROL_BODY_BYTES = 16_384;
// Past this size the rest of the body is not worth reading just to deliver a clean 413.
const HARD_BODY_LIMIT_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;

const ROUTE_HEALTHZ = "GET /healthz";
const ROUTE_ACTION = "POST /v1/sessions/:botId/actions";
const ROUTE_DELETE = "DELETE /v1/sessions/:botId";
const ROUTE_UNMATCHED = "unmatched";
const ROUTE_UNAUTHORIZED = "unauthorized";
const ROUTE_OVERSIZED = "oversized";

type RouteName =
  | typeof ROUTE_HEALTHZ
  | typeof ROUTE_ACTION
  | typeof ROUTE_DELETE
  | typeof ROUTE_UNMATCHED
  | typeof ROUTE_UNAUTHORIZED
  | typeof ROUTE_OVERSIZED;

type RouteMatch = { route: typeof ROUTE_ACTION | typeof ROUTE_DELETE; botIdSegment: string };

type BodyRead =
  | { kind: "read"; rawBody: string }
  | { kind: "too_large"; drained: boolean }
  | { kind: "aborted" };

type Outcome = {
  route: RouteName;
  status: number;
  body: Record<string, unknown> | null;
  botId?: string;
  action?: AgentBrowserAction["type"];
  closeConnection?: boolean;
  destroyRequest?: boolean;
};

type ControlContext = {
  secret: string;
  sessions: SessionManager;
  hub: ViewerHub;
  version: string;
  logger: Logger;
};

const ERROR_STATUS: Record<AgentBrowserErrorCode, number> = {
  UNAUTHORIZED: 401,
  INVALID_INPUT: 400,
  SESSION_NOT_FOUND: 404,
  CAPACITY: 429,
  BLOCKED_URL: 422,
  STALE_REF: 409,
  ACTION_FAILED: 422,
  TIMEOUT: 504,
  INTERNAL: 500,
};

function errorOutcome(
  route: RouteName,
  code: AgentBrowserErrorCode,
  message: string,
  extra: Partial<Outcome> = {}
): Outcome {
  return {
    route,
    status: ERROR_STATUS[code],
    body: { error: code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
    ...extra,
  };
}

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

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function matchRoute(method: string | undefined, path: string): RouteMatch | null {
  const segments = path.split("/");
  if (segments[0] !== "" || segments[1] !== "v1" || segments[2] !== "sessions" || !segments[3]) return null;

  const botIdSegment = segments[3];
  if (segments.length === 4) return method === "DELETE" ? { route: ROUTE_DELETE, botIdSegment } : null;
  if (segments.length === 5 && segments[4] === "actions") {
    return method === "POST" ? { route: ROUTE_ACTION, botIdSegment } : null;
  }
  return null;
}

function handleHealthz(context: ControlContext): Outcome {
  const { sessions, maxSessions } = context.sessions.stats();
  return {
    route: ROUTE_HEALTHZ,
    status: 200,
    body: { ok: true, sessions, maxSessions, viewers: context.hub.total(), version: context.version },
  };
}

async function handleAction(context: ControlContext, botId: string, rawBody: string): Promise<Outcome> {
  const parsed = agentBrowserActionSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    return errorOutcome(ROUTE_ACTION, "INVALID_INPUT", "The action is not valid.", { botId });
  }

  const action = parsed.data;
  try {
    const state: AgentBrowserPageState = await context.sessions.perform(botId, action);
    return { route: ROUTE_ACTION, status: 200, body: state, botId, action: action.type };
  } catch (error) {
    // Anything else could carry raw browser text, so it is reported with a fixed message.
    if (error instanceof AgentBrowserActionError) {
      return errorOutcome(ROUTE_ACTION, error.code, error.message, { botId, action: action.type });
    }
    return errorOutcome(ROUTE_ACTION, "INTERNAL", "The browser action failed unexpectedly.", {
      botId,
      action: action.type,
    });
  }
}

async function handleDelete(context: ControlContext, botId: string): Promise<Outcome> {
  await context.sessions.destroy(botId);
  return { route: ROUTE_DELETE, status: 204, body: null, botId };
}

async function handleRoute(context: ControlContext, match: RouteMatch, rawBody: string): Promise<Outcome> {
  const botId = agentBrowserBotIdSchema.safeParse(match.botIdSegment);
  if (!botId.success) return errorOutcome(match.route, "INVALID_INPUT", "The bot id is not valid.");

  try {
    if (match.route === ROUTE_ACTION) return await handleAction(context, botId.data, rawBody);
    return await handleDelete(context, botId.data);
  } catch {
    return errorOutcome(match.route, "INTERNAL", "The request failed unexpectedly.", { botId: botId.data });
  }
}

async function resolveOutcome(context: ControlContext, req: IncomingMessage): Promise<Outcome | null> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && path === "/healthz") {
    req.resume();
    return handleHealthz(context);
  }

  // Checked before the body is looked at, so an unauthenticated caller learns nothing about limits or routes.
  const authorized = verifyAgentBrowserAuthorization(context.secret, req.headers.authorization);
  const bodyRead = await readBody(req);
  if (bodyRead.kind === "aborted") return null;

  if (!authorized) {
    const oversized = bodyRead.kind === "too_large";
    return errorOutcome(ROUTE_UNAUTHORIZED, "UNAUTHORIZED", "Missing or invalid authorization.", {
      closeConnection: oversized,
      destroyRequest: oversized && !bodyRead.drained,
    });
  }
  if (bodyRead.kind === "too_large") {
    return {
      route: ROUTE_OVERSIZED,
      status: 413,
      body: { error: "INVALID_INPUT", message: "The request body is too large." },
      closeConnection: true,
      destroyRequest: !bodyRead.drained,
    };
  }

  const match = matchRoute(req.method, path);
  if (!match) return { route: ROUTE_UNMATCHED, status: 404, body: null };

  return handleRoute(context, match, bodyRead.rawBody);
}

function logOutcome(logger: Logger, outcome: Outcome): void {
  const fields: LogFields = { route: outcome.route, status: outcome.status };
  if (outcome.botId !== undefined) fields.botId = outcome.botId;
  if (outcome.action !== undefined) fields.action = outcome.action;
  const error = outcome.body?.error;
  if (typeof error === "string") fields.error = error;

  if (outcome.status >= 500) {
    logger.error("control request", fields);
    return;
  }
  if (outcome.route === ROUTE_HEALTHZ) {
    logger.debug("control request", fields);
    return;
  }
  logger.info("control request", fields);
}

function sendOutcome(logger: Logger, req: IncomingMessage, res: ServerResponse, outcome: Outcome): void {
  const payload = outcome.body === null ? "" : JSON.stringify(outcome.body);
  const headers: OutgoingHttpHeaders = {
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  };
  if (outcome.body !== null) headers["content-type"] = "application/json";
  if (outcome.closeConnection) headers.connection = "close";
  if (outcome.destroyRequest) res.once("finish", () => req.destroy());

  res.writeHead(outcome.status, headers);
  res.end(payload);
  logOutcome(logger, outcome);
}

async function handleRequest(
  context: ControlContext,
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

export type ControlServerDeps = {
  secret: string;
  sessions: SessionManager;
  hub: ViewerHub;
  version: string;
  logger: Logger;
};

export function createControlServer(deps: ControlServerDeps): Server {
  const context: ControlContext = { ...deps };

  const server = createServer((req, res) => {
    handleRequest(context, req, res).catch(() => {
      if (res.headersSent) {
        req.socket.destroy();
        return;
      }
      try {
        sendOutcome(
          context.logger,
          req,
          res,
          errorOutcome(ROUTE_UNMATCHED, "INTERNAL", "The request failed unexpectedly.")
        );
      } catch {
        req.socket.destroy();
      }
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  return server;
}

export { MAX_CONTROL_BODY_BYTES };
