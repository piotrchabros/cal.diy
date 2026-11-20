import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AGENT_BROWSER_KEYS } from "@calcom/lib/agentBrowser/contract";
import { describe, expect, it, vi } from "vitest";
import { createAgentBrowserGatewayError } from "../browser/IAgentBrowserGateway";
import type {
  MeetingAgentBrowserActions,
  MeetingAgentBrowserPage,
  MeetingAgentRequest,
} from "./IMeetingAgent";
import {
  BrowserUrlProvenanceGuard,
  executeBrowserTool,
  isBrowserToolName,
  MEETING_AGENT_BROWSER_TOOLS,
  MEETING_AGENT_BROWSER_VISION_TOOL,
} from "./meetingAgentBrowserTools";

const at = new Date("2026-01-01T10:00:00Z");

const page: MeetingAgentBrowserPage = {
  url: "https://cal.com/pricing",
  title: "Pricing",
  snapshot: 'Scroll: 0% (viewport 1/3)\nElements:\n[e1] link "Docs" → https://docs.example.org/start',
  screenshot: null,
};

function makeBrowser(overrides: Partial<MeetingAgentBrowserActions> = {}): MeetingAgentBrowserActions {
  return {
    open: vi.fn().mockResolvedValue(page),
    perform: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<MeetingAgentRequest> = {}): MeetingAgentRequest {
  return {
    command: "open cal.com pricing",
    speakerName: "Anna",
    source: "SPEECH",
    recentLines: [],
    ...overrides,
  };
}

function makeGuard(request: MeetingAgentRequest = makeRequest()): BrowserUrlProvenanceGuard {
  return new BrowserUrlProvenanceGuard(request);
}

describe("browser tool definitions", () => {
  it("exposes the browser tools in order and a separate vision tool", () => {
    expect(MEETING_AGENT_BROWSER_TOOLS.map((tool) => tool.name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_back",
      "browser_close",
    ]);
    expect(MEETING_AGENT_BROWSER_VISION_TOOL.name).toBe("browser_screenshot");
  });

  it.each(
    [...MEETING_AGENT_BROWSER_TOOLS, MEETING_AGENT_BROWSER_VISION_TOOL].map(
      (tool) => [tool.name, tool] as const
    )
  )("%s has a strict closed schema requiring every property", (_name, tool) => {
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(Object.keys(tool.input_schema.properties ?? {}));
    // Strict tools reject string length and pattern constraints.
    expect(JSON.stringify(tool.input_schema)).not.toMatch(/maxLength|minLength|"pattern"/);
  });

  it("limits keys, scroll direction and amount to the contract enums", () => {
    const byName = new Map(MEETING_AGENT_BROWSER_TOOLS.map((tool) => [tool.name, tool]));
    const pressProps = byName.get("browser_press")?.input_schema.properties as Record<
      string,
      { enum: string[] }
    >;
    const scrollProps = byName.get("browser_scroll")?.input_schema.properties as Record<
      string,
      { enum: string[] }
    >;

    expect(pressProps.key.enum).toEqual([...AGENT_BROWSER_KEYS]);
    expect(scrollProps.direction.enum).toEqual(["up", "down"]);
    expect(scrollProps.amount.enum).toEqual(["page", "half"]);
  });

  it("recognises browser tool names only", () => {
    expect(isBrowserToolName("browser_click")).toBe(true);
    expect(isBrowserToolName("browser_screenshot")).toBe(true);
    expect(isBrowserToolName("share_screen")).toBe(false);
  });
});

describe("executeBrowserTool", () => {
  it("opens an allowed URL and returns URL, title and snapshot", async () => {
    const browser = makeBrowser();

    const outcome = await executeBrowserTool(
      "browser_open",
      { url: "https://www.cal.com/pricing" },
      browser,
      makeGuard()
    );

    expect(browser.open).toHaveBeenCalledWith("https://www.cal.com/pricing");
    expect(outcome).toEqual({
      ok: true,
      content: `URL: ${page.url}\nTitle: ${page.title}\n${page.snapshot}`,
    });
  });

  it.each([
    [{ url: "ftp://cal.com" }],
    [{ url: "not a url" }],
    [{ url: `https://cal.com/${"a".repeat(2048)}` }],
    [{}],
  ])("rejects invalid browser_open input %j", async (input) => {
    const browser = makeBrowser();

    const outcome = await executeBrowserTool("browser_open", input, browser, makeGuard());

    expect(outcome.ok).toBe(false);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("routes a ref target to click and other text to click_text", async () => {
    const browser = makeBrowser();
    const guard = makeGuard();

    await executeBrowserTool("browser_click", { target: "e12" }, browser, guard);
    await executeBrowserTool("browser_click", { target: "  Sign up  " }, browser, guard);

    expect(browser.perform).toHaveBeenNthCalledWith(1, { type: "click", ref: "e12" });
    expect(browser.perform).toHaveBeenNthCalledWith(2, { type: "click_text", text: "Sign up" });
  });

  it("maps type, press, scroll, snapshot and back to their commands", async () => {
    const browser = makeBrowser();
    const guard = makeGuard();

    await executeBrowserTool("browser_type", { ref: "e3", text: "pricing", submit: true }, browser, guard);
    await executeBrowserTool("browser_press", { key: "Escape" }, browser, guard);
    await executeBrowserTool("browser_scroll", { direction: "down", amount: "half" }, browser, guard);
    await executeBrowserTool("browser_snapshot", {}, browser, guard);
    await executeBrowserTool("browser_back", {}, browser, guard);

    expect(vi.mocked(browser.perform).mock.calls.map(([command]) => command)).toEqual([
      { type: "type", ref: "e3", text: "pricing", submit: true },
      { type: "press", key: "Escape" },
      { type: "scroll", direction: "down", amount: "half" },
      { type: "snapshot" },
      { type: "back" },
    ]);
  });

  it.each([
    ["browser_click", { target: "" }],
    ["browser_click", { target: "x".repeat(201) }],
    ["browser_type", { ref: "button", text: "a", submit: false }],
    ["browser_type", { ref: "e1", text: "a".repeat(501), submit: false }],
    ["browser_press", { key: "F5" }],
    ["browser_scroll", { direction: "left", amount: "page" }],
  ])("rejects invalid %s input %j", async (name, input) => {
    const browser = makeBrowser();

    const outcome = await executeBrowserTool(name, input, browser, makeGuard());

    expect(outcome).toEqual({ ok: false, content: "Invalid input." });
    expect(browser.perform).not.toHaveBeenCalled();
  });

  it("closes the browser", async () => {
    const browser = makeBrowser();

    const outcome = await executeBrowserTool("browser_close", {}, browser, makeGuard());

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, content: "Browser closed and screen share stopped." });
  });

  it("returns Unknown tool for other names and for the screenshot tool without vision", async () => {
    const browser = makeBrowser();

    expect(await executeBrowserTool("share_screen", {}, browser, makeGuard())).toEqual({
      ok: false,
      content: "Unknown tool.",
    });
    expect(await executeBrowserTool("browser_screenshot", {}, browser, makeGuard())).toEqual({
      ok: false,
      content: "Unknown tool.",
    });
    expect(browser.perform).not.toHaveBeenCalled();
  });

  it("returns the screenshot as an image block when vision is enabled", async () => {
    const browser = makeBrowser({
      perform: vi
        .fn()
        .mockResolvedValue({ ...page, screenshot: { mediaType: "image/jpeg", base64: "AAAA" } }),
    });

    const outcome = await executeBrowserTool("browser_screenshot", {}, browser, makeGuard(), {
      vision: true,
    });

    expect(browser.perform).toHaveBeenCalledWith({ type: "screenshot" });
    expect(outcome).toEqual({
      ok: true,
      content: [
        { type: "text", text: `URL: ${page.url}\nTitle: ${page.title}\n${page.snapshot}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      ],
    });
  });

  it("falls back to text when no screenshot was captured", async () => {
    const outcome = await executeBrowserTool("browser_screenshot", {}, makeBrowser(), makeGuard(), {
      vision: true,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain("No screenshot was captured.");
  });

  it.each([
    ["SESSION_NOT_FOUND", "No page is open; use browser_open."],
    ["STALE_REF", "That element is gone; call browser_snapshot and retry."],
    ["BLOCKED_URL", "That address is not allowed."],
    ["CAPACITY", "The browser is busy in other meetings."],
    ["TIMEOUT", "The page did not respond in time."],
    ["UNAVAILABLE", "The browser is not available right now."],
    ["ACTION_FAILED", "The browser action failed."],
    ["INTERNAL", "The browser action failed."],
  ] as const)("maps %s to a model-facing message without the raw error text", async (kind, message) => {
    const browser = makeBrowser({
      perform: vi.fn().mockRejectedValue(createAgentBrowserGatewayError(kind, "secret internals")),
    });

    const outcome = await executeBrowserTool("browser_click", { target: "e1" }, browser, makeGuard());

    expect(outcome).toEqual({ ok: false, content: message });
  });

  it("hides unexpected errors behind a generic message", async () => {
    const browser = makeBrowser({ open: vi.fn().mockRejectedValue(new Error("recall exploded")) });

    const outcome = await executeBrowserTool(
      "browser_open",
      { url: "https://cal.com" },
      browser,
      makeGuard()
    );

    expect(outcome).toEqual({ ok: false, content: "The browser action failed." });
  });
});

describe("BrowserUrlProvenanceGuard", () => {
  it("refuses a host that never appeared and does not open it", async () => {
    const browser = makeBrowser();

    const outcome = await executeBrowserTool(
      "browser_open",
      { url: "https://evil.example" },
      browser,
      makeGuard()
    );

    expect(outcome).toEqual({
      ok: false,
      content: "Search for it first or ask the participant to confirm the address.",
    });
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("allows a host named in the command, ignoring case and www", () => {
    const guard = makeGuard(makeRequest({ command: "show WWW.Cal.com/pricing please" }));

    expect(guard.allows("https://cal.com/pricing")).toBe(true);
    expect(guard.allows("https://www.cal.com")).toBe(true);
    expect(guard.allows("https://app.cal.com")).toBe(false);
  });

  it("understands spoken dots in commands", () => {
    expect(makeGuard(makeRequest({ command: "open cal dot com" })).allows("https://cal.com")).toBe(true);
  });

  it("understands the spoken Polish kropka between labels", () => {
    const allows = (command: string, url: string): boolean => makeGuard(makeRequest({ command })).allows(url);

    expect(allows("wejść na stronę Google kropka com", "https://google.com")).toBe(true);
    expect(allows("otwórz bluebee kropka marketing", "https://bluebee.marketing")).toBe(true);
    expect(allows("pokaż allegro Kropką pl", "https://allegro.pl")).toBe(true);
    expect(allows("wejdź na onet kropka com kropka pl", "https://onet.com.pl")).toBe(true);
  });

  it("allows a brand named by a participant on its own domain only", () => {
    const guard = makeGuard(makeRequest({ command: "wejść na stronę Google" }));

    expect(guard.allows("https://google.com")).toBe(true);
    expect(guard.allows("https://www.google.com/search")).toBe(true);
    expect(guard.allows("https://google.pl")).toBe(true);
    expect(guard.allows("https://google.co.uk")).toBe(true);
    expect(guard.allows("https://maps.google.com")).toBe(false);
    expect(guard.allows("https://google.evil.com")).toBe(false);
    expect(guard.allows("https://evilgoogle.com")).toBe(false);
    expect(guard.allows("https://google.com.evil.io")).toBe(false);
  });

  it("never treats filler words, short words or numbers as brands", () => {
    const guard = makeGuard(
      makeRequest({ command: "BlueBeeBot, wejdź na stronę www i pokaż the page 2026 na ok" })
    );

    expect(guard.allows("https://strona.pl")).toBe(false);
    expect(guard.allows("https://page.com")).toBe(false);
    expect(guard.allows("https://www.com")).toBe(false);
    expect(guard.allows("https://bluebeebot.com")).toBe(false);
    expect(guard.allows("https://2026.com")).toBe(false);
    expect(guard.allows("https://ok.com")).toBe(false);
  });

  it("takes brands from participants only, not from page text", async () => {
    const browser = makeBrowser({
      open: vi.fn().mockResolvedValue({ ...page, snapshot: "Visit Evilcorp today" }),
    });
    const guard = makeGuard();

    await executeBrowserTool("browser_open", { url: "https://cal.com/pricing" }, browser, guard);

    expect(guard.allows("https://evilcorp.com")).toBe(false);
  });

  it("allows a host from the meeting so far", () => {
    const guard = makeGuard(
      makeRequest({
        command: "open the page Bob posted",
        recentLines: [{ source: "CHAT", speakerName: "Bob", text: "see https://docs.acme.io/guide", at }],
      })
    );

    expect(guard.allows("https://docs.acme.io/other")).toBe(true);
  });

  it("allows a host linked from a page opened earlier in the run", async () => {
    const browser = makeBrowser();
    const guard = makeGuard();

    await executeBrowserTool("browser_open", { url: "https://cal.com/pricing" }, browser, guard);

    expect(guard.allows("https://docs.example.org/start")).toBe(true);
  });

  it("allows hosts from web_search and web_fetch result blocks", () => {
    const guard = makeGuard(makeRequest({ command: "find the cal.com docs" }));
    const blocks = [
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        content: [
          {
            type: "web_search_result",
            url: "https://found.example.net/a",
            title: "A",
            encrypted_content: "x",
            page_age: null,
          },
        ],
      },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srv_2",
        content: {
          type: "web_fetch_result",
          url: "https://fetched.example.com/b",
          retrieved_at: null,
          content: {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "body" },
            title: null,
            citations: null,
          },
        },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_3",
        content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
      },
    ] as unknown as BetaContentBlock[];

    guard.recordServerToolResults(blocks);

    expect(guard.allows("https://found.example.net/other")).toBe(true);
    expect(guard.allows("https://fetched.example.com")).toBe(true);
    expect(guard.allows("https://unrelated.example.com")).toBe(false);
  });

  it("refuses unparsable URLs", () => {
    expect(makeGuard().allows("not a url")).toBe(false);
  });
});
