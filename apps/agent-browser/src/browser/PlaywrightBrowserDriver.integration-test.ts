import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSilentLogger } from "../logger";
import type { IBrowserSession, PageInfo } from "../sessions/IBrowserDriver";
import { AgentBrowserActionError } from "../sessions/IBrowserDriver";
import type { NavigationPolicy } from "./navigationGuard";
import { PlaywrightBrowserDriver } from "./PlaywrightBrowserDriver";
import { assertPublicHost, checkNavigableUrl } from "./urlPolicy";

// Opt-in because it launches a real Chromium; it also needs the browser build matching the installed Playwright.
const browserAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const enabled = process.env.AGENT_BROWSER_IT === "1" && browserAvailable;

const HOME_PAGE = `<!doctype html><title>Home</title>
<h1>Fixture home</h1>
<a href="/second">Second page</a>
<form action="/second"><input name="q" placeholder="Search"></form>
<button onclick="window.open('/second')">Open popup</button>
<button onclick="alert('hi'); document.getElementById('status').textContent = 'after alert'">Alert</button>
<p id="status">before alert</p>
<a href="/download">Get file</a>
<div style="height: 4000px">Tall</div>`;

function startFixtureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" }).end(HOME_PAGE);
    } else if (path === "/second") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Second</title><h1>Second page</h1>");
    } else if (path === "/download") {
      response
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment; filename=x.bin",
        })
        .end("binary");
    } else if (path === "/redirect-local") {
      const { port } = server.address() as AddressInfo;
      response.writeHead(302, { location: `http://localhost:${port}/second` }).end();
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// The real policy refuses loopback, so only the fixture's exact origin is let through; everything else keeps
// the production rules, with DNS answering nothing so no test can reach the network.
function fixturePolicy(origin: string): NavigationPolicy {
  const fixtureHost = new URL(origin).hostname;
  return {
    checkUrl: (raw) => {
      if (URL.canParse(raw) && new URL(raw).origin === origin) return { ok: true, url: new URL(raw) };
      return checkNavigableUrl(raw);
    },
    assertHost: (hostname) =>
      hostname === fixtureHost
        ? Promise.resolve()
        : assertPublicHost(hostname, async () => {
            throw new Error("no DNS in tests");
          }),
  };
}

async function expectActionError(work: Promise<unknown>, code: string): Promise<void> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(AgentBrowserActionError);
  expect((error as AgentBrowserActionError).code).toBe(code);
}

function refOf(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((candidate) => pattern.test(candidate));
  const ref = line?.match(/^\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`No element matching ${pattern} in snapshot:\n${snapshot}`);
  return ref;
}

describe.skipIf(!enabled)("PlaywrightBrowserDriver (real Chromium)", () => {
  let server: Server;
  let origin: string;
  let driver: PlaywrightBrowserDriver;
  let session: IBrowserSession;
  const frames: Buffer[] = [];
  const pages: PageInfo[] = [];

  beforeAll(async () => {
    server = await startFixtureServer();
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    driver = new PlaywrightBrowserDriver({
      // Root in CI containers cannot use the Chromium sandbox.
      chromiumSandbox: false,
      screencastFps: 30,
      jpegQuality: 60,
      logger: createSilentLogger(),
      policy: fixturePolicy(origin),
    });
    session = await driver.createSession("bot-it", {
      onFrame: (jpeg) => frames.push(jpeg),
      onPage: (info) => pages.push(info),
    });
  });

  afterAll(async () => {
    await driver?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("opens a page, reports it and streams JPEG frames", async () => {
    const result = await session.perform({ type: "goto", url: `${origin}/` });

    expect(result.title).toBe("Home");
    expect(result.snapshot).toContain('link "Second page"');
    expect(session.currentPage()).toEqual({ url: `${origin}/`, title: "Home" });
    expect(pages.at(-1)).toEqual({ url: `${origin}/`, title: "Home" });
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(frames[0]?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("clicks a ref and goes back", async () => {
    const home = await session.perform({ type: "goto", url: `${origin}/` });
    const clicked = await session.perform({ type: "click", ref: refOf(home.snapshot, /link "Second page"/) });
    expect(clicked.url).toBe(`${origin}/second`);

    const back = await session.perform({ type: "back" });
    expect(back.url).toBe(`${origin}/`);
  });

  it("types into a field and submits it", async () => {
    const home = await session.perform({ type: "goto", url: `${origin}/` });
    const result = await session.perform({
      type: "type",
      ref: refOf(home.snapshot, /textbox "Search"/),
      text: "pricing",
      submit: true,
    });
    expect(result.url).toBe(`${origin}/second?q=pricing`);
  });

  it("presses a key and scrolls", async () => {
    await session.perform({ type: "goto", url: `${origin}/` });
    await session.perform({ type: "press", key: "Tab" });
    const scrolled = await session.perform({ type: "scroll", direction: "down", amount: "page" });
    expect(scrolled.snapshot).not.toMatch(/^Scroll: 0%/);
  });

  it("dismisses dialogs instead of hanging", async () => {
    await session.perform({ type: "goto", url: `${origin}/` });
    const result = await session.perform({ type: "click_text", text: "Alert" });
    expect(result.snapshot).toContain("after alert");
  });

  it("collapses a popup into the main page", async () => {
    await session.perform({ type: "goto", url: `${origin}/` });
    await session.perform({ type: "click_text", text: "Open popup" });
    expect(session.currentPage().url).toBe(`${origin}/second`);
  });

  it("refuses blocked schemes and local hosts before navigating", async () => {
    await expectActionError(session.perform({ type: "goto", url: "file:///etc/passwd" }), "BLOCKED_URL");
    const { port } = server.address() as AddressInfo;
    await expectActionError(
      session.perform({ type: "goto", url: `http://localhost:${port}/` }),
      "BLOCKED_URL"
    );
  });

  it("blocks a redirect to a local host and parks the page on about:blank", async () => {
    await expectActionError(
      session.perform({ type: "goto", url: `${origin}/redirect-local` }),
      "BLOCKED_URL"
    );
    expect(session.currentPage().url).toBe("about:blank");
  });

  it("refuses downloads", async () => {
    await expectActionError(session.perform({ type: "goto", url: `${origin}/download` }), "ACTION_FAILED");
  });

  it("reports a stale ref", async () => {
    await session.perform({ type: "goto", url: `${origin}/` });
    await expectActionError(session.perform({ type: "click", ref: "e999" }), "STALE_REF");
  });

  it("returns a JPEG screenshot only for the screenshot action", async () => {
    const snapshot = await session.perform({ type: "snapshot" });
    expect(snapshot.screenshot).toBeNull();

    const result = await session.perform({ type: "screenshot" });
    expect(result.screenshot?.mediaType).toBe("image/jpeg");
    expect(Buffer.from(result.screenshot?.base64 ?? "", "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8])
    );
  });
});
