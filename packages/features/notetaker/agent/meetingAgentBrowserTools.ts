import type {
  BetaContentBlock,
  BetaImageBlockParam,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  AGENT_BROWSER_KEYS,
  AGENT_BROWSER_MAX_TYPE_LENGTH,
  AGENT_BROWSER_MAX_URL_LENGTH,
} from "@calcom/lib/agentBrowser/contract";
import { z } from "zod";
import type { AgentBrowserGatewayErrorKind } from "../browser/IAgentBrowserGateway";
import { getAgentBrowserGatewayErrorInfo } from "../browser/IAgentBrowserGateway";
import type {
  MeetingAgentBrowserActions,
  MeetingAgentBrowserCommand,
  MeetingAgentBrowserPage,
  MeetingAgentRequest,
} from "./IMeetingAgent";

const MAX_CLICK_TEXT_LENGTH = 200;
const REF_PATTERN = /^e\d{1,5}$/;
// Hostnames as they appear in prose or URLs; the TLD must be alphabetic so version numbers do not match.
const HOSTNAME_PATTERN = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Speech-to-text often writes "cal dot com" for cal.com, or "google kropka com" in Polish speech.
const SPOKEN_DOT_PATTERN = /\s+(?:dot|kropk[aą])\s+/gi;
// A string rather than a literal because a regex literal with the `u` flag does not compile under the ES5 target.
// Splitting on Unicode letters keeps "stronę" whole instead of leaving an ASCII "stron" behind.
const WORD_SEPARATOR_PATTERN_SOURCE = "[^\\p{L}\\p{N}-]+";
const WORD_SEPARATOR_PATTERN: RegExp = new RegExp(WORD_SEPARATOR_PATTERN_SOURCE, "u");
const BRAND_WORD_PATTERN = /^(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// A brand word may only be followed by a public suffix: one label (com, pl) or a ccTLD second level (co.uk, com.pl).
const BRAND_SUFFIX_PATTERN = /^(?:[a-z]{2,63}|(?:co|com|org|net|gov|edu|ac)\.[a-z]{2})$/;
// Words participants say around an address, so "wejdź na stronę" never lets strona.pl or page.com open.
const BRAND_STOPWORDS: ReadonlySet<string> = new Set<string>([
  "strona",
  "stronę",
  "stronie",
  "strony",
  "stronka",
  "stronkę",
  "wejdź",
  "wejść",
  "wejdźmy",
  "pokaż",
  "pokazać",
  "otwórz",
  "otworzyć",
  "kropka",
  "kropką",
  "the",
  "and",
  "open",
  "show",
  "page",
  "site",
  "website",
  "dot",
  "www",
  "http",
  "https",
  "com",
  "pl",
  "bot",
  "bota",
  "bluebeebot",
  "bluebeebota",
  "bluebeebotem",
  "bluebeebotowi",
  "bluebeeboty",
  "bluebeebocie",
]);

export type BrowserToolName =
  | "browser_open"
  | "browser_snapshot"
  | "browser_click"
  | "browser_type"
  | "browser_press"
  | "browser_scroll"
  | "browser_back"
  | "browser_close"
  | "browser_screenshot";

export type BrowserToolOutcome = {
  ok: boolean;
  content: string | Array<BetaTextBlockParam | BetaImageBlockParam>;
};

const EMPTY_INPUT_SCHEMA: Tool["input_schema"] = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {},
};

// Strict tools reject minLength/maxLength/pattern, so the contract caps are stated in descriptions and enforced by the zod schemas below.
export const MEETING_AGENT_BROWSER_TOOLS: Tool[] = [
  {
    name: "browser_open",
    description:
      "Open a webpage in the shared browser that everyone in the meeting sees. The first call starts showing the browser in the meeting; later calls replace the page. Returns the page URL, title and a snapshot with element refs.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: `Absolute http or https URL, at most ${AGENT_BROWSER_MAX_URL_LENGTH} characters, e.g. https://example.com/page.`,
        },
      },
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the current page again: URL, title, scroll position, headings, interactive elements with refs such as [e12], and visible text. Use it when a ref no longer works or the page may have changed.",
    strict: true,
    input_schema: EMPTY_INPUT_SCHEMA,
  },
  {
    name: "browser_click",
    description:
      "Click an element on the current page, by its ref from the latest snapshot or by the visible text of a link or button. Returns the updated snapshot.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        target: {
          type: "string",
          description: `A ref such as e12, or the visible text of the element to click (at most ${MAX_CLICK_TEXT_LENGTH} characters).`,
        },
      },
    },
  },
  {
    name: "browser_type",
    description:
      "Replace the text in a field on the current page, such as a search box, and optionally press Enter to submit it. Never use it for passwords, payment or personal data. Returns the updated snapshot.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "text", "submit"],
      properties: {
        ref: { type: "string", description: "Ref of the field from the latest snapshot, such as e12." },
        text: {
          type: "string",
          description: `Text to enter, at most ${AGENT_BROWSER_MAX_TYPE_LENGTH} characters.`,
        },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
    },
  },
  {
    name: "browser_press",
    description:
      "Press a key on the current page, for example Enter, Escape or PageDown. Returns the updated snapshot.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: {
        key: { type: "string", enum: [...AGENT_BROWSER_KEYS], description: "Key to press." },
      },
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the current page up or down by a page or half a page. Returns the updated snapshot.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["direction", "amount"],
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "string", enum: ["page", "half"] },
      },
    },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page in the browser history. Returns the updated snapshot.",
    strict: true,
    input_schema: EMPTY_INPUT_SCHEMA,
  },
  {
    name: "browser_close",
    description:
      "Close the browser and stop showing it in the meeting. Use it when asked to stop sharing, close or hide the page.",
    strict: true,
    input_schema: EMPTY_INPUT_SCHEMA,
  },
];

export const MEETING_AGENT_BROWSER_VISION_TOOL: Tool = {
  name: "browser_screenshot",
  description:
    "Take a screenshot of the visible part of the current page. Use it only when the snapshot does not show what you need, such as images, charts or layout.",
  strict: true,
  input_schema: EMPTY_INPUT_SCHEMA,
};

const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...MEETING_AGENT_BROWSER_TOOLS.map((tool) => tool.name),
  MEETING_AGENT_BROWSER_VISION_TOOL.name,
]);

export function isBrowserToolName(name: string): name is BrowserToolName {
  return BROWSER_TOOL_NAMES.has(name);
}

const openInputSchema = z.object({
  url: z
    .string()
    .max(AGENT_BROWSER_MAX_URL_LENGTH)
    .refine((value) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol)),
});
const emptyInputSchema = z.object({});
const clickInputSchema = z.object({ target: z.string().trim().min(1).max(MAX_CLICK_TEXT_LENGTH) });
const typeInputSchema = z.object({
  ref: z.string().regex(REF_PATTERN),
  text: z.string().max(AGENT_BROWSER_MAX_TYPE_LENGTH),
  submit: z.boolean(),
});
const pressInputSchema = z.object({ key: z.enum(AGENT_BROWSER_KEYS) });
const scrollInputSchema = z.object({ direction: z.enum(["up", "down"]), amount: z.enum(["page", "half"]) });

function normalizeHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.+$/, "");
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/**
 * Lets browser_open load only hosts that already appeared in this run: in the command, the meeting so far,
 * earlier tool results or web search/fetch results. Like web_fetch's own rule, this keeps page text or a
 * prompt injection from steering the browser to an address nobody mentioned.
 */
export class BrowserUrlProvenanceGuard {
  private readonly hosts = new Set<string>();
  private readonly brandWords = new Set<string>();

  constructor(request?: MeetingAgentRequest) {
    if (!request) return;
    for (const text of [request.command, ...request.recentLines.map((line) => line.text)]) {
      this.recordText(text);
      this.recordBrandWords(text);
    }
  }

  recordText(text: string): void {
    const normalized = text.replace(SPOKEN_DOT_PATTERN, ".");
    for (const host of normalized.match(HOSTNAME_PATTERN) ?? []) this.hosts.add(normalizeHost(host));
    for (const ip of normalized.match(IPV4_PATTERN) ?? []) this.hosts.add(ip);
  }

  recordServerToolResults(blocks: readonly BetaContentBlock[]): void {
    for (const block of blocks) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const result of block.content) this.recordUrl(result.url);
      } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
        this.recordUrl(block.content.url);
      }
    }
  }

  allows(url: string): boolean {
    if (!URL.canParse(url)) return false;
    const host = normalizeHost(new URL(url).hostname);
    return this.hosts.has(host) || this.allowsBrandHost(host);
  }

  // Only participants' own words count as brands ("wejdź na Google" means google.com); page text and tool
  // results record exact hosts alone, so a page cannot name a word and unlock that word's domain.
  private recordBrandWords(text: string): void {
    for (const word of text.toLowerCase().split(WORD_SEPARATOR_PATTERN)) {
      if (BRAND_WORD_PATTERN.test(word) && !BRAND_STOPWORDS.has(word)) this.brandWords.add(word);
    }
  }

  private allowsBrandHost(host: string): boolean {
    const dotIndex = host.indexOf(".");
    if (dotIndex === -1) return false;
    return (
      this.brandWords.has(host.slice(0, dotIndex)) && BRAND_SUFFIX_PATTERN.test(host.slice(dotIndex + 1))
    );
  }

  private recordUrl(url: string): void {
    if (URL.canParse(url)) this.hosts.add(normalizeHost(new URL(url).hostname));
  }
}

function errorMessageForKind(kind: AgentBrowserGatewayErrorKind | undefined): string {
  switch (kind) {
    case "SESSION_NOT_FOUND":
      return "No page is open; use browser_open.";
    case "STALE_REF":
      return "That element is gone; call browser_snapshot and retry.";
    case "BLOCKED_URL":
      return "That address is not allowed.";
    case "CAPACITY":
      return "The browser is busy in other meetings.";
    case "TIMEOUT":
      return "The page did not respond in time.";
    case "UNAVAILABLE":
      return "The browser is not available right now.";
    default:
      return "The browser action failed.";
  }
}

function formatPage(page: MeetingAgentBrowserPage): string {
  return `URL: ${page.url}\nTitle: ${page.title}\n${page.snapshot}`;
}

function parseCommand(name: BrowserToolName, input: unknown): MeetingAgentBrowserCommand | null {
  switch (name) {
    case "browser_snapshot":
    case "browser_back":
    case "browser_screenshot": {
      if (!emptyInputSchema.safeParse(input).success) return null;
      if (name === "browser_snapshot") return { type: "snapshot" };
      if (name === "browser_back") return { type: "back" };
      return { type: "screenshot" };
    }
    case "browser_click": {
      const parsed = clickInputSchema.safeParse(input);
      if (!parsed.success) return null;
      const target = parsed.data.target;
      return REF_PATTERN.test(target) ? { type: "click", ref: target } : { type: "click_text", text: target };
    }
    case "browser_type": {
      const parsed = typeInputSchema.safeParse(input);
      return parsed.success ? { type: "type", ...parsed.data } : null;
    }
    case "browser_press": {
      const parsed = pressInputSchema.safeParse(input);
      return parsed.success ? { type: "press", key: parsed.data.key } : null;
    }
    case "browser_scroll": {
      const parsed = scrollInputSchema.safeParse(input);
      return parsed.success ? { type: "scroll", ...parsed.data } : null;
    }
    default:
      return null;
  }
}

function pageOutcome(page: MeetingAgentBrowserPage, guard: BrowserUrlProvenanceGuard): BrowserToolOutcome {
  const text = formatPage(page);
  // Links on a page the bot opened count as provenance for the next browser_open.
  guard.recordText(text);
  return { ok: true, content: text };
}

export async function executeBrowserTool(
  name: string,
  input: unknown,
  browser: MeetingAgentBrowserActions,
  guard: BrowserUrlProvenanceGuard,
  options?: { vision?: boolean }
): Promise<BrowserToolOutcome> {
  if (!isBrowserToolName(name)) return { ok: false, content: "Unknown tool." };
  if (name === "browser_screenshot" && !options?.vision) return { ok: false, content: "Unknown tool." };

  try {
    if (name === "browser_open") {
      const parsed = openInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, content: "Invalid input: url must be an http or https URL." };
      if (!guard.allows(parsed.data.url)) {
        return {
          ok: false,
          content: "Search for it first or ask the participant to confirm the address.",
        };
      }
      return pageOutcome(await browser.open(parsed.data.url), guard);
    }

    if (name === "browser_close") {
      if (!emptyInputSchema.safeParse(input).success) return { ok: false, content: "Invalid input." };
      await browser.close();
      return { ok: true, content: "Browser closed and screen share stopped." };
    }

    const command = parseCommand(name, input);
    if (!command) return { ok: false, content: "Invalid input." };
    const page = await browser.perform(command);

    if (name !== "browser_screenshot") return pageOutcome(page, guard);

    const text = formatPage(page);
    guard.recordText(text);
    if (!page.screenshot) return { ok: true, content: `${text}\n(No screenshot was captured.)` };
    return {
      ok: true,
      content: [
        { type: "text", text },
        {
          type: "image",
          source: { type: "base64", media_type: page.screenshot.mediaType, data: page.screenshot.base64 },
        },
      ],
    };
  } catch (error) {
    // Only the error kind reaches the model: messages may contain internals or page-controlled text.
    return { ok: false, content: errorMessageForKind(getAgentBrowserGatewayErrorInfo(error)?.kind) };
  }
}
