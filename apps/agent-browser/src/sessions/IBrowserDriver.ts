import type { AgentBrowserAction, AgentBrowserErrorCode } from "@calcom/lib/agentBrowser/contract";

type PageInfo = { url: string; title: string };

type ActionResult = PageInfo & {
  snapshot: string;
  screenshot: { mediaType: "image/jpeg"; base64: string } | null;
};

interface BrowserSessionHooks {
  onFrame(jpeg: Buffer): void;
  onPage(info: PageInfo): void;
}

interface IBrowserSession {
  perform(action: AgentBrowserAction): Promise<ActionResult>;
  currentPage(): PageInfo;
  // True once the page is gone for good, such as after a browser crash, even if dispose was never called.
  isClosed(): boolean;
  dispose(): Promise<void>;
}

interface IBrowserDriver {
  createSession(botId: string, hooks: BrowserSessionHooks): Promise<IBrowserSession>;
  close(): Promise<void>;
}

// The message goes back to the meeting agent as is, so it must be short and written by us,
// never raw Playwright text that could carry page content or internal details.
class AgentBrowserActionError extends Error {
  constructor(
    readonly code: AgentBrowserErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentBrowserActionError";
  }
}

export type { ActionResult, BrowserSessionHooks, IBrowserDriver, IBrowserSession, PageInfo };
export { AgentBrowserActionError };
