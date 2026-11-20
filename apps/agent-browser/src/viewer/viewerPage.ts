import { AGENT_BROWSER_VIEWPORT } from "@calcom/lib/agentBrowser/contract";

const ADDRESS_BAR_HEIGHT = 40;
const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,64}$/;

const VIEWER_STYLE = `
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
body { display: flex; flex-direction: column; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e5e7eb; }
#bar { flex: 0 0 ${ADDRESS_BAR_HEIGHT}px; height: ${ADDRESS_BAR_HEIGHT}px; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 0 14px; background: #1f2937; border-bottom: 1px solid #374151; white-space: nowrap; overflow: hidden; }
#url { flex: 0 1 auto; max-width: 60%; overflow: hidden; text-overflow: ellipsis; padding: 3px 10px; border-radius: 12px; background: #111827; color: #f9fafb; }
#title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; color: #9ca3af; }
#stage { position: relative; flex: 1 1 auto; min-height: 0; }
#screen { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
#status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; font-size: 28px; color: #d1d5db; background: #000; }
#status[hidden] { display: none; }
`;

// Runs in the Recall bot's browser. It only ever sets textContent, so a page title cannot inject markup,
// and it reads the token from its own URL, so the server never reflects it into the HTML.
const VIEWER_SCRIPT = `
(() => {
  const MIN_RETRY_MS = 1000;
  const MAX_RETRY_MS = 5000;
  const TEXT = {
    connecting: "Connecting to the browser\\u2026",
    waiting: "Waiting for BlueBeeBot to open a page\\u2026",
    restarted: "The browser restarted. Ask BlueBeeBot to open the page again.",
    closed: "The browser was closed.",
  };

  const canvas = document.getElementById("screen");
  const context = canvas.getContext("2d");
  const status = document.getElementById("status");
  const urlText = document.getElementById("url");
  const titleText = document.getElementById("title");
  const token = new URLSearchParams(location.search).get("token") || "";
  const socketUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host +
    "/agent-browser/ws?token=" + encodeURIComponent(token);

  let retryMs = MIN_RETRY_MS;
  let closedByServer = false;
  let restarted = false;
  let decoding = false;
  let pendingFrame = null;

  const showStatus = (text) => {
    status.textContent = text;
    status.hidden = false;
  };

  const clearScreen = () => {
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    urlText.textContent = "";
    titleText.textContent = "";
  };

  const applyState = (state) => {
    if (state === "live") {
      restarted = false;
      status.hidden = true;
      return;
    }
    clearScreen();
    if (state === "closed") {
      closedByServer = true;
      showStatus(TEXT.closed);
      return;
    }
    if (state === "restarted") restarted = true;
    showStatus(restarted ? TEXT.restarted : TEXT.waiting);
  };

  // Frames arrive faster than a slow machine decodes them; only the newest pending one is kept.
  const drawFrame = async (buffer) => {
    if (decoding) {
      pendingFrame = buffer;
      return;
    }
    decoding = true;
    try {
      const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/jpeg" }));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    } catch (error) {
      // A corrupt frame is skipped; the next one repaints the whole screen.
    } finally {
      decoding = false;
    }
    if (pendingFrame) {
      const next = pendingFrame;
      pendingFrame = null;
      drawFrame(next);
    }
  };

  const onText = (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.t === "hello" || message.t === "state") applyState(message.state);
    if (message.t === "page") {
      urlText.textContent = String(message.url || "");
      titleText.textContent = String(message.title || "");
    }
  };

  const connect = () => {
    const socket = new WebSocket(socketUrl);
    socket.binaryType = "arraybuffer";
    let opened = false;

    socket.onopen = () => {
      opened = true;
      retryMs = MIN_RETRY_MS;
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") onText(event.data);
      else drawFrame(event.data);
    };
    socket.onclose = () => {
      if (closedByServer) return;
      // A connection that was up and dropped without a closed state means the service went away.
      if (opened) restarted = true;
      clearScreen();
      showStatus(restarted ? TEXT.restarted : TEXT.connecting);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  };

  clearScreen();
  showStatus(TEXT.connecting);
  connect();
})();
`;

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("The viewer page nonce has an unexpected format");
}

function renderViewerPage(input: { nonce: string }): string {
  assertNonce(input.nonce);
  const { width, height } = AGENT_BROWSER_VIEWPORT;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>BlueBeeBot browser</title>
<style>${VIEWER_STYLE}</style>
</head>
<body>
<div id="bar"><span id="url"></span><span id="title"></span></div>
<div id="stage">
<canvas id="screen" width="${width}" height="${height}"></canvas>
<div id="status"></div>
</div>
<script nonce="${input.nonce}">${VIEWER_SCRIPT}</script>
</body>
</html>
`;
}

function renderUnauthorizedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link expired</title>
<style>html, body { margin: 0; height: 100%; background: #000; color: #d1d5db; font: 24px system-ui, sans-serif; } body { display: flex; align-items: center; justify-content: center; text-align: center; }</style>
</head>
<body><p>This browser view link is invalid or has expired.</p></body>
</html>
`;
}

export { ADDRESS_BAR_HEIGHT, renderUnauthorizedPage, renderViewerPage };
