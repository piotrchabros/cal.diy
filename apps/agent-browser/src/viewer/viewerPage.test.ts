// @vitest-environment node
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnauthorizedPage, renderViewerPage } from "./viewerPage";

const NONCE = "dGVzdC1ub25jZS0xMjM0NQ==";

type FakeSocket = {
  url: string;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

// Runs the page script against a fake WebSocket, so the client's state handling is tested without a server.
function loadPage(url = "https://cal.example.com/agent-browser/view?token=v1.bot1.1.2.sig%2B") {
  const sockets: FakeSocket[] = [];
  const dom = new JSDOM(renderViewerPage({ nonce: NONCE }), {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      const fakeContext = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
      Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { value: () => fakeContext });
      Object.defineProperty(window, "WebSocket", {
        value: function FakeWebSocket(this: FakeSocket, socketUrl: string) {
          this.url = socketUrl;
          this.binaryType = "blob";
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          sockets.push(this);
        },
      });
    },
  });
  const document = dom.window.document;
  const status = () => document.getElementById("status");
  const send = (message: unknown) => sockets.at(-1)?.onmessage?.({ data: JSON.stringify(message) });
  return { dom, document, sockets, status, send };
}

describe("renderViewerPage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a 1280x680 canvas under an address bar with only the nonce-tagged inline script", () => {
    const html = renderViewerPage({ nonce: NONCE });

    expect(html).toContain('<canvas id="screen" width="1280" height="680">');
    expect(html).toContain('<div id="bar">');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).not.toMatch(/\b(src|href)=/);
    expect(html).not.toContain("innerHTML");
  });

  it("refuses a nonce that could break out of the attribute", () => {
    expect(() => renderViewerPage({ nonce: 'abc"><script>alert(1)</script>' })).toThrow();
    expect(() => renderViewerPage({ nonce: "short" })).toThrow();
  });

  it("connects to the same-origin WebSocket with the token from its own URL", () => {
    const { sockets, status } = loadPage();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://cal.example.com/agent-browser/ws?token=v1.bot1.1.2.sig%2B");
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
    expect(status()?.textContent).toContain("Connecting");
  });

  it("uses ws:// when the page is served over http", () => {
    const { sockets } = loadPage("http://127.0.0.1:4411/agent-browser/view?token=t");
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:4411/agent-browser/ws?token=t");
  });

  it("shows waiting, then the page address as text once live", () => {
    const { document, sockets, status, send } = loadPage();
    sockets[0]?.onopen?.();

    send({ t: "hello", width: 1280, height: 680, state: "waiting" });
    expect(status()?.hidden).toBe(false);
    expect(status()?.textContent).toContain("Waiting for BlueBeeBot");

    send({ t: "state", state: "live" });
    send({ t: "page", url: "https://example.com/", title: "<b>Example</b>" });
    expect(status()?.hidden).toBe(true);
    expect(document.getElementById("url")?.textContent).toBe("https://example.com/");
    expect(document.getElementById("title")?.textContent).toBe("<b>Example</b>");
    expect(document.querySelector("#title b")).toBeNull();
  });

  it("shows closed and stops reconnecting after the server closes the session", () => {
    vi.useFakeTimers();
    const { sockets, status, send } = loadPage();
    sockets[0]?.onopen?.();
    send({ t: "state", state: "live" });

    send({ t: "state", state: "closed" });
    sockets[0]?.onclose?.();
    vi.advanceTimersByTime(10_000);

    expect(status()?.textContent).toContain("closed");
    expect(sockets).toHaveLength(1);
  });

  it("reports a restart when an open connection drops and retries with a 1 s to 5 s backoff", () => {
    vi.useFakeTimers();
    const { sockets, status, send, dom } = loadPage();
    // The jsdom window has its own timers, which the faked Node timers do not control.
    dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
    sockets[0]?.onopen?.();
    send({ t: "state", state: "live" });

    sockets[0]?.onclose?.();
    expect(status()?.textContent).toContain("restarted");

    const delays: number[] = [];
    let elapsed = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before && waited < 10_000) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
      elapsed += waited;
      sockets.at(-1)?.onclose?.();
    }

    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(elapsed).toBe(17_000);

    // A reconnect after the restart keeps the restart notice until a page is live again.
    sockets.at(-1)?.onopen?.();
    send({ t: "hello", width: 1280, height: 680, state: "waiting" });
    expect(status()?.textContent).toContain("restarted");
    send({ t: "state", state: "live" });
    expect(status()?.hidden).toBe(true);
  });
});

describe("renderUnauthorizedPage", () => {
  it("has no script", () => {
    const html = renderUnauthorizedPage();
    expect(html).not.toContain("<script");
    expect(html).toContain("invalid or has expired");
  });
});
