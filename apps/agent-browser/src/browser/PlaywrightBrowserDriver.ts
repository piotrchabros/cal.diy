import type { AgentBrowserAction } from "@calcom/lib/agentBrowser/contract";
import { AGENT_BROWSER_VIEWPORT } from "@calcom/lib/agentBrowser/contract";
import type {
  Browser,
  BrowserContext,
  Frame,
  LaunchOptions,
  Locator,
  Page,
  Request,
  Route,
} from "playwright";
import { chromium, errors } from "playwright";
import type { Logger } from "../logger";
import { redactUrl } from "../logger";
import type {
  ActionResult,
  BrowserSessionHooks,
  IBrowserDriver,
  IBrowserSession,
  PageInfo,
} from "../sessions/IBrowserDriver";
import { AgentBrowserActionError } from "../sessions/IBrowserDriver";
import type { DeniedDecision, NavigationPolicy } from "./navigationGuard";
import { blockedUrlDecision, createDefaultNavigationPolicy, NavigationGuard } from "./navigationGuard";
import {
  collectPageSnapshot,
  DEFAULT_COLLECT_OPTIONS,
  formatPageSnapshot,
  SNAPSHOT_REF_ATTRIBUTE,
} from "./pageSnapshot";
import { openPageScreencastTransport, Screencaster } from "./Screencaster";
import { BlockedHostError } from "./urlPolicy";

type PlaywrightBrowserDriverOptions = {
  chromiumSandbox: boolean;
  screencastFps: number;
  jpegQuality: number;
  logger: Logger;
  policy?: NavigationPolicy;
  launchOptions?: Pick<LaunchOptions, "executablePath" | "channel">;
};

type SessionDeps = {
  context: BrowserContext;
  hooks: BrowserSessionHooks;
  guard: NavigationGuard;
  logger: Logger;
  screencastFps: number;
  jpegQuality: number;
  onDisposed: () => void;
};

const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const LOAD_WAIT_MS = 5_000;
const NETWORK_SETTLE_MS = 1_500;
// mouse.wheel returns before the page has scrolled.
const SCROLL_SETTLE_MS = 200;
// Leaves room for the settle and the snapshot while staying inside the gateway's 25 s HTTP timeout.
const DEADLINE_SLACK_MS = 4_000;
// window.open runs inside the page's event handler, so the popup's request can arrive just after the click returns.
const POPUP_GRACE_MS = 250;
const NAVIGATING_ACTIONS = new Set<AgentBrowserAction["type"]>(["goto", "back"]);
const INTERACTING_ACTIONS = new Set<AgentBrowserAction["type"]>(["click", "click_text", "type", "press"]);

const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-component-update",
  "--no-first-run",
  "--disable-sync",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-features=Translate,MediaRouter",
];

const noop = (): void => {};

function deny(decision: DeniedDecision): AgentBrowserActionError {
  return new AgentBrowserActionError(decision.code, decision.message);
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AgentBrowserActionError("TIMEOUT", "The page took too long to respond.")),
      timeoutMs
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

class PlaywrightBrowserSession implements IBrowserSession {
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly deps: SessionDeps;
  private readonly screencaster: Screencaster<Page>;
  private info: PageInfo = { url: "about:blank", title: "" };
  private lastPublished = "";
  // Set when the guard stops a main-frame navigation during the current action, so the action reports why.
  private actionBlock: DeniedDecision | null = null;
  private pendingNavigation: Promise<void> = Promise.resolve();
  private popupFollowed = false;
  private popupWaiter: (() => void) | null = null;
  private disposed = false;

  private constructor(deps: SessionDeps, page: Page) {
    this.deps = deps;
    this.context = deps.context;
    this.page = page;
    this.screencaster = new Screencaster<Page>({
      open: openPageScreencastTransport,
      fps: deps.screencastFps,
      quality: deps.jpegQuality,
      onFrame: (jpeg) => deps.hooks.onFrame(jpeg),
      logger: deps.logger,
    });
  }

  static async open(deps: SessionDeps): Promise<PlaywrightBrowserSession> {
    const holder: { session: PlaywrightBrowserSession | null } = { session: null };
    // The guard is in place before the first page exists, so no request can slip past it.
    await deps.context.route(
      "**/*",
      (route) => holder.session?.guardRoute(route) ?? route.abort("blockedbyclient")
    );
    const page = await deps.context.newPage();
    const session = new PlaywrightBrowserSession(deps, page);
    holder.session = session;
    session.attachListeners();
    await session.screencaster.retarget(page);
    return session;
  }

  async perform(action: AgentBrowserAction): Promise<ActionResult> {
    if (this.disposed || this.page.isClosed()) {
      throw new AgentBrowserActionError(
        "ACTION_FAILED",
        "The browser session was closed; open the page again."
      );
    }
    this.actionBlock = null;
    this.popupFollowed = false;
    const timeoutMs =
      (NAVIGATING_ACTIONS.has(action.type) ? NAVIGATION_TIMEOUT_MS : ACTION_TIMEOUT_MS) + DEADLINE_SLACK_MS;
    try {
      return await withDeadline(this.run(action), timeoutMs);
    } catch (error) {
      throw this.toActionError(error);
    }
  }

  currentPage(): PageInfo {
    return this.info;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.screencaster.stop();
    await this.context.close().catch(noop);
    this.deps.onDisposed();
  }

  private attachListeners(): void {
    this.page.on("dialog", (dialog) => {
      dialog.dismiss().catch(noop);
    });
    this.page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame()) this.track(this.enforceCommittedUrl(frame.url()));
    });
    // Keeps a single tab: the viewer streams only the main page, so a popup would show nothing to the meeting.
    // Its navigation was already redirected into the main page by the route guard.
    this.context.on("page", (popup) => {
      if (popup !== this.page) popup.close().catch(noop);
    });
  }

  private async run(action: AgentBrowserAction): Promise<ActionResult> {
    await this.execute(action);
    if (INTERACTING_ACTIONS.has(action.type)) await this.waitForPossiblePopup();
    await this.settle();
    if (this.actionBlock) throw deny(this.actionBlock);

    const screenshot =
      action.type === "screenshot"
        ? {
            mediaType: "image/jpeg" as const,
            base64: (
              await this.page.screenshot({
                type: "jpeg",
                quality: this.deps.jpegQuality,
                timeout: ACTION_TIMEOUT_MS,
              })
            ).toString("base64"),
          }
        : null;
    const snapshot = await this.snapshot();
    await this.publishPage();
    return { ...this.info, snapshot, screenshot };
  }

  private async execute(action: AgentBrowserAction): Promise<void> {
    const page = this.page;
    switch (action.type) {
      case "goto": {
        const decision = await this.deps.guard.checkTarget(action.url);
        if (!decision.allowed) throw deny(decision);
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        return;
      }
      case "click":
        await (await this.refLocator(action.ref)).click({ timeout: ACTION_TIMEOUT_MS });
        return;
      case "click_text": {
        const target = page.getByText(action.text, { exact: false }).first();
        if ((await target.count()) === 0) {
          throw new AgentBrowserActionError("ACTION_FAILED", "No element on the page shows that text.");
        }
        await target.click({ timeout: ACTION_TIMEOUT_MS });
        return;
      }
      case "type": {
        const field = await this.refLocator(action.ref);
        await field.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
        if (action.submit) await field.press("Enter", { timeout: ACTION_TIMEOUT_MS });
        return;
      }
      case "press":
        await page.keyboard.press(action.key);
        return;
      case "scroll": {
        const { width, height } = AGENT_BROWSER_VIEWPORT;
        const distance =
          (action.amount === "page" ? height : height / 2) * (action.direction === "down" ? 1 : -1);
        // The wheel scrolls whatever is under the pointer, which also covers apps that scroll an inner pane.
        await page.mouse.move(width / 2, height / 2);
        await page.mouse.wheel(0, distance);
        await page.waitForTimeout(SCROLL_SETTLE_MS);
        return;
      }
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        return;
      case "snapshot":
      case "screenshot":
        return;
    }
  }

  private async refLocator(ref: string): Promise<Locator> {
    const locator = this.page.locator(`[${SNAPSHOT_REF_ATTRIBUTE}="${ref}"]`);
    if ((await locator.count()) === 0) {
      throw new AgentBrowserActionError(
        "STALE_REF",
        "That element is no longer on the page; take a new snapshot."
      );
    }
    return locator.first();
  }

  private async waitForPossiblePopup(): Promise<void> {
    if (this.popupFollowed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POPUP_GRACE_MS);
      this.popupWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.popupWaiter = null;
  }

  private async settle(): Promise<void> {
    await this.pendingNavigation;
    await this.page.waitForLoadState("domcontentloaded", { timeout: LOAD_WAIT_MS }).catch(noop);
    await this.page.waitForLoadState("networkidle", { timeout: NETWORK_SETTLE_MS }).catch(noop);
    // A popup or a blocked redirect found while settling starts its own navigation.
    await this.pendingNavigation;
  }

  private async snapshot(): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.page.evaluate(collectPageSnapshot, DEFAULT_COLLECT_OPTIONS);
        return formatPageSnapshot(raw);
      } catch {
        // A navigation that starts mid-evaluate destroys the execution context; the next document is read instead.
        await this.page.waitForLoadState("domcontentloaded", { timeout: LOAD_WAIT_MS }).catch(noop);
      }
    }
    return "The page content could not be read.";
  }

  private async guardRoute(route: Route): Promise<void> {
    const request = route.request();
    const isNavigation = request.isNavigationRequest();
    const frame = this.frameOf(request);
    // A navigation without a known frame is a popup's first one: Playwright has not created the popup page yet.
    const framePage = frame?.page() ?? null;
    if (framePage !== this.page && (frame !== null || isNavigation)) {
      // The popup's request reaches the guard before the click that opened it returns, unlike the context's
      // page event, which waits for the response; following it here lets the click's settle wait for it.
      await route.abort("blockedbyclient").catch(noop);
      if (isNavigation && (frame === null || frame === framePage?.mainFrame())) {
        this.track(this.followPopup(request.url()));
        this.popupFollowed = true;
        this.popupWaiter?.();
      }
      return;
    }

    const isMainFrame = frame === this.page.mainFrame();
    try {
      const decision = await this.deps.guard.checkRequest({ url: request.url(), isNavigation, isMainFrame });
      if (decision.allowed) {
        await route.continue();
        return;
      }
      if (isNavigation && isMainFrame) this.actionBlock = decision;
      const fields = { url: redactUrl(request.url()), navigation: isNavigation };
      if (isNavigation) this.deps.logger.info("browser request blocked", fields);
      else this.deps.logger.debug("browser request blocked", fields);
    } catch {
      // Fall through to abort: a request the guard could not judge is not sent.
    }
    await route.abort("blockedbyclient").catch(noop);
  }

  private frameOf(request: Request): Frame | null {
    try {
      return request.frame();
    } catch {
      // Service worker requests have no frame either; they are blocked anyway and get the subresource checks.
      return null;
    }
  }

  private async enforceCommittedUrl(url: string): Promise<void> {
    const decision = await this.deps.guard.checkCommittedUrl(url);
    if (decision.allowed) {
      await this.publishPage();
      return;
    }
    this.actionBlock = decision;
    this.deps.logger.info("browser navigation blocked after commit", { url: redactUrl(url) });
    await this.page.goto("about:blank").catch(noop);
  }

  private async followPopup(url: string): Promise<void> {
    const decision = await this.deps.guard.checkTarget(url);
    if (!decision.allowed) {
      this.actionBlock = decision;
      return;
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch(noop);
  }

  private track(navigation: Promise<void>): void {
    this.pendingNavigation = Promise.all([this.pendingNavigation, navigation.catch(noop)]).then(noop);
  }

  private async publishPage(): Promise<void> {
    if (this.page.isClosed()) return;
    const title = await this.page.title().catch(() => this.info.title);
    this.info = { url: this.page.url(), title };
    const key = `${this.info.url}\n${this.info.title}`;
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.deps.hooks.onPage(this.info);
  }

  private toActionError(error: unknown): AgentBrowserActionError {
    if (error instanceof AgentBrowserActionError) return error;
    if (error instanceof BlockedHostError) return deny(blockedUrlDecision(error.reason));
    // A navigation the guard aborted surfaces as a generic net error; the recorded block says why.
    if (this.actionBlock) return deny(this.actionBlock);
    if (error instanceof errors.TimeoutError) {
      return new AgentBrowserActionError("TIMEOUT", "The page took too long to respond.");
    }
    if (error instanceof Error && error.message.includes("Download is starting")) {
      return new AgentBrowserActionError(
        "ACTION_FAILED",
        "That link starts a file download, which is not allowed."
      );
    }
    this.deps.logger.warn("browser action failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return new AgentBrowserActionError("ACTION_FAILED", "The browser could not complete that action.");
  }
}

class PlaywrightBrowserDriver implements IBrowserDriver {
  private readonly options: PlaywrightBrowserDriverOptions;
  private readonly policy: NavigationPolicy;
  private readonly sessions = new Set<PlaywrightBrowserSession>();
  private browser: Promise<Browser> | null = null;
  private closed = false;

  constructor(options: PlaywrightBrowserDriverOptions) {
    this.options = options;
    this.policy = options.policy ?? createDefaultNavigationPolicy();
  }

  async createSession(botId: string, hooks: BrowserSessionHooks): Promise<IBrowserSession> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: AGENT_BROWSER_VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      locale: "en-US",
      ignoreHTTPSErrors: false,
      bypassCSP: false,
    });

    try {
      const session = await PlaywrightBrowserSession.open({
        context,
        hooks,
        guard: new NavigationGuard({ policy: this.policy }),
        logger: this.options.logger.child({ botId }),
        screencastFps: this.options.screencastFps,
        jpegQuality: this.options.jpegQuality,
        onDisposed: () => this.sessions.delete(session),
      });
      this.sessions.add(session);
      return session;
    } catch (error) {
      await context.close().catch(noop);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions].map((session) => session.dispose()));
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.then((instance) => instance.close()).catch(noop);
  }

  private getBrowser(): Promise<Browser> {
    if (this.closed) return Promise.reject(new Error("The browser driver is closed"));
    if (this.browser) return this.browser;

    const launching = chromium.launch({
      headless: true,
      chromiumSandbox: this.options.chromiumSandbox,
      args: LAUNCH_ARGS,
      ...this.options.launchOptions,
    });
    this.browser = launching;
    launching.then(
      (browser) => {
        // A crashed browser is relaunched by the next session rather than leaving the service unusable.
        browser.on("disconnected", () => {
          if (this.browser === launching) this.browser = null;
          if (!this.closed) this.options.logger.warn("browser disconnected");
        });
      },
      () => {
        if (this.browser === launching) this.browser = null;
      }
    );
    return launching;
  }
}

export type { PlaywrightBrowserDriverOptions };
export { PlaywrightBrowserDriver };
