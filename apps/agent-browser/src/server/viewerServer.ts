import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { verifyAgentBrowserViewerToken } from "@calcom/lib/agentBrowser/contract";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { Logger } from "../logger";
import type { SessionManager } from "../sessions/SessionManager";
import type { ViewerHub } from "../viewer/ViewerHub";
import { renderUnauthorizedPage, renderViewerPage } from "../viewer/viewerPage";

const VIEW_PATH = "/agent-browser/view";
const WS_PATH = "/agent-browser/ws";
const PING_INTERVAL_MS = 20_000;
const MAX_MISSED_PONGS = 2;
const MAX_CLIENT_MESSAGE_BYTES = 1024;
// Above the client message limit, so an oversized message reaches our handler and closes with 1008
// instead of ws's own 1009; anything larger than this is cut off by ws before it is buffered.
const WS_MAX_PAYLOAD_BYTES = 16 * 1024;
const POLICY_VIOLATION = 1008;
const TRY_AGAIN_LATER = 1013;
const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 1000;
const STATUS_TEXT = { 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests" } as const;

type ViewerServerDeps = {
  secret: string;
  sessions: Pick<SessionManager, "isRevoked">;
  hub: ViewerHub;
  logger: Logger;
  now?: () => Date;
  pingIntervalMs?: number;
};

type ViewerServer = {
  server: Server;
  // Exposed so tests can drive the heartbeat without waiting for the interval.
  checkHeartbeats(): void;
  close(): Promise<void>;
};

type Viewer = { botId: string; missedPongs: number };

type TokenCheck = { ok: true; botId: string } | { ok: false; status: 401 | 429 };

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src blob: data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function parseRequest(req: IncomingMessage): { path: string; token: string | null } {
  // Only path and query are used; the base is a placeholder because the Host header is client-controlled.
  const url = new URL(req.url ?? "/", "http://viewer.invalid");
  return { path: url.pathname, token: url.searchParams.get("token") };
}

function sendHtml(res: ServerResponse, status: number, html: string, csp: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": csp,
  });
  res.end(html);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-length": 0, "cache-control": "no-store" });
  res.end();
}

function rejectUpgrade(socket: Duplex, status: 401 | 404 | 429): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`
  );
}

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

export function createViewerServer(deps: ViewerServerDeps): ViewerServer {
  const { hub, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const viewers = new Map<WebSocket, Viewer>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  const checkToken = (token: string | null): TokenCheck => {
    if (!token) return { ok: false, status: 401 };
    const verified = verifyAgentBrowserViewerToken({ secret: deps.secret, token, now: now() });
    if (!verified || deps.sessions.isRevoked(verified.botId, verified.issuedAt)) {
      return { ok: false, status: 401 };
    }
    return { ok: true, botId: verified.botId };
  };

  const server = createServer((req, res) => {
    req.resume();
    const { path, token } = parseRequest(req);
    if (path !== VIEW_PATH || (req.method !== "GET" && req.method !== "HEAD")) {
      sendEmpty(res, 404);
      return;
    }

    const check = checkToken(token);
    if (!check.ok) {
      logger.info("viewer page rejected", { status: 401 });
      sendHtml(res, 401, renderUnauthorizedPage(), "default-src 'none'; style-src 'unsafe-inline'");
      return;
    }

    const nonce = randomBytes(16).toString("base64");
    sendHtml(res, 200, renderViewerPage({ nonce }), contentSecurityPolicy(nonce));
    logger.debug("viewer page served", { botId: check.botId });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  const attach = (ws: WebSocket, botId: string): void => {
    if (!hub.add(botId, ws)) {
      // Another viewer took the last slot between the pre-upgrade check and now.
      ws.close(TRY_AGAIN_LATER, "too many viewers");
      return;
    }
    const viewer: Viewer = { botId, missedPongs: 0 };
    viewers.set(ws, viewer);

    ws.on("pong", () => {
      viewer.missedPongs = 0;
    });
    ws.on("message", (data) => {
      // The page never sends anything; a large message is someone probing the endpoint.
      if (rawDataLength(data) > MAX_CLIENT_MESSAGE_BYTES) ws.close(POLICY_VIOLATION, "message too large");
    });
    ws.on("error", () => ws.terminate());
    ws.once("close", () => viewers.delete(ws));
    logger.info("viewer connected", { botId, viewers: hub.count(botId) });
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const { path, token } = parseRequest(req);
    if (path !== WS_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }

    const check = checkToken(token);
    if (!check.ok) {
      logger.info("viewer connection rejected", { status: check.status });
      rejectUpgrade(socket, check.status);
      return;
    }
    if (!hub.canAdd(check.botId)) {
      logger.info("viewer connection rejected", { botId: check.botId, status: 429 });
      rejectUpgrade(socket, 429);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, check.botId));
  });

  const checkHeartbeats = (): void => {
    for (const [ws, viewer] of viewers) {
      if (viewer.missedPongs >= MAX_MISSED_PONGS) {
        logger.info("viewer timed out", { botId: viewer.botId });
        viewers.delete(ws);
        ws.terminate();
        continue;
      }
      viewer.missedPongs += 1;
      ws.ping();
    }
  };

  const heartbeat = setInterval(checkHeartbeats, deps.pingIntervalMs ?? PING_INTERVAL_MS);
  heartbeat.unref();

  // Viewers are asked to close by the hub first; the grace lets their close frames reach the page,
  // and whoever has not finished the handshake by then is cut off.
  const waitForViewersToLeave = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (viewers.size === 0) {
        resolve();
        return;
      }
      const deadline = setTimeout(resolve, CLOSE_GRACE_MS);
      let remaining = viewers.size;
      for (const ws of viewers.keys()) {
        ws.once("close", () => {
          remaining -= 1;
          if (remaining > 0) return;
          clearTimeout(deadline);
          resolve();
        });
      }
    });

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    const stopped = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await waitForViewersToLeave();
    for (const ws of viewers.keys()) ws.terminate();
    viewers.clear();
    wss.close();
    await stopped;
  };

  return { server, checkHeartbeats, close };
}

export type { ViewerServer, ViewerServerDeps };
export { MAX_CLIENT_MESSAGE_BYTES, PING_INTERVAL_MS };
