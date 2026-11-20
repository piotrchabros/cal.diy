import type { AgentBrowserAction } from "@calcom/lib/agentBrowser/contract";
import type {
  ActionResult,
  BrowserSessionHooks,
  IBrowserDriver,
  IBrowserSession,
  PageInfo,
} from "./IBrowserDriver";
import { AgentBrowserActionError } from "./IBrowserDriver";

const FAKE_JPEG_BASE64 = Buffer.from("fake-jpeg").toString("base64");

class FakeBrowserSession implements IBrowserSession {
  readonly performed: AgentBrowserAction[] = [];
  disposed = false;
  private page: PageInfo = { url: "about:blank", title: "" };
  private readonly queuedErrors: Error[] = [];
  private readonly gates: Promise<void>[] = [];

  constructor(
    readonly botId: string,
    readonly hooks: BrowserSessionHooks
  ) {}

  failNext(error: Error): void {
    this.queuedErrors.push(error);
  }

  // Holds the next perform until the returned function is called, to test serialization.
  holdNext(): () => void {
    let release = (): void => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.push(wait);
    return release;
  }

  emitFrame(jpeg: Buffer): void {
    this.hooks.onFrame(jpeg);
  }

  async perform(action: AgentBrowserAction): Promise<ActionResult> {
    this.performed.push(action);
    const gate = this.gates.shift();
    if (gate) await gate;
    if (this.disposed) throw new AgentBrowserActionError("ACTION_FAILED", "The browser session was closed.");
    const error = this.queuedErrors.shift();
    if (error) throw error;

    if (action.type === "goto") {
      this.page = { url: action.url, title: `Title of ${action.url}` };
      this.hooks.onPage(this.page);
    }

    return {
      ...this.page,
      snapshot: `Fake snapshot of ${this.page.url}`,
      screenshot: action.type === "screenshot" ? { mediaType: "image/jpeg", base64: FAKE_JPEG_BASE64 } : null,
    };
  }

  currentPage(): PageInfo {
    return this.page;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeBrowserDriver implements IBrowserDriver {
  readonly sessions: FakeBrowserSession[] = [];
  closed = false;
  private createError: Error | null = null;

  failNextCreate(error: Error): void {
    this.createError = error;
  }

  lastSession(botId: string): FakeBrowserSession | undefined {
    return this.sessions.filter((session) => session.botId === botId).at(-1);
  }

  async createSession(botId: string, hooks: BrowserSessionHooks): Promise<FakeBrowserSession> {
    const error = this.createError;
    this.createError = null;
    if (error) throw error;

    const session = new FakeBrowserSession(botId, hooks);
    this.sessions.push(session);
    return session;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export { FakeBrowserDriver, FakeBrowserSession };
