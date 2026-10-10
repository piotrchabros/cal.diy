// UNVERIFIED AGAINST THE REAL SERVICE (Google Meet in Chrome): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "playwright";
import { chromium, errors } from "playwright";
import type { Logger } from "../../logger";
import { buildChromeLaunchOptions, sanitizeBrowserError } from "./chromeLaunch";
import type {
  ElementReading,
  MeetingBrowserLauncher,
  MeetingBrowserOptions,
  MeetingPage,
} from "./MeetingPage";
import { readElementsInPage } from "./readElementsInPage";

const NAVIGATION_TIMEOUT_MS = 45000;
const ACTION_TIMEOUT_MS = 10000;
const FRAME_POLL_INTERVAL_MS = 150;

type StorageState = Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>;

function isStorageState(value: unknown): value is StorageState {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray(Reflect.get(value, "cookies")) && Array.isArray(Reflect.get(value, "origins"));
}

class PlaywrightMeetingPage implements MeetingPage {
  private readonly closedHandlers: (() => void)[] = [];
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page
  ) {
    page.on("close", () => this.fireClosed());
    page.on("crash", () => this.fireClosed());
    browser.on("disconnected", () => this.fireClosed());
  }

  private fireClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closedHandlers) {
      try {
        handler();
      } catch {
        // A throwing handler must not stop the others or surface into Playwright's event emitter.
      }
    }
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error(`Meeting browser ${operation} failed (page is closed)`);
    try {
      return await action();
    } catch (error) {
      throw sanitizeBrowserError(operation, error);
    }
  }

  async goto(url: string): Promise<void> {
    await this.run("goto", () =>
      this.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
    );
  }

  currentUrl(): string {
    return this.page.url();
  }

  isVisible(selector: string): Promise<boolean> {
    return this.run("isVisible", () => this.page.locator(selector).first().isVisible());
  }

  async waitForVisible(selector: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return this.isVisible(selector);
    if (this.closed) throw new Error("Meeting browser waitForVisible failed (page is closed)");
    try {
      await this.page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    } catch (error) {
      if (error instanceof errors.TimeoutError) return false;
      throw sanitizeBrowserError("waitForVisible", error);
    }
  }

  async click(selector: string): Promise<void> {
    await this.run("click", () => this.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT_MS }));
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.run("fill", () =>
      this.page.locator(selector).first().fill(value, { timeout: ACTION_TIMEOUT_MS })
    );
  }

  async pressKey(key: string): Promise<void> {
    await this.run("pressKey", () => this.page.keyboard.press(key));
  }

  async readText(selector: string): Promise<string | null> {
    const texts = await this.readTexts(selector);
    return texts[0] ?? null;
  }

  readTexts(selector: string): Promise<string[]> {
    return this.run("readTexts", () => this.page.locator(selector).allTextContents());
  }

  readElements(
    selector: string,
    attributeNames: readonly string[],
    innerTextSelector: string | null
  ): Promise<ElementReading[]> {
    return this.run("readElements", () =>
      this.page
        .locator(selector)
        .evaluateAll(readElementsInPage, { attributeNames: [...attributeNames], innerTextSelector })
    );
  }

  // page.frames() lists the main frame first, then child frames, so the main frame wins when several match.
  private async firstVisibleInAnyFrame(selector: string): Promise<Locator | null> {
    for (const frame of this.page.frames()) {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible()) return locator;
    }
    return null;
  }

  private async anyFrameVisible(selector: string): Promise<boolean> {
    return (await this.firstVisibleInAnyFrame(selector)) !== null;
  }

  async waitForVisibleInAnyFrame(selector: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return this.run("waitForVisibleInAnyFrame", () => this.anyFrameVisible(selector));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.run("waitForVisibleInAnyFrame", () => this.anyFrameVisible(selector))) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(FRAME_POLL_INTERVAL_MS, remaining)));
    }
  }

  async clickInAnyFrame(selector: string): Promise<void> {
    await this.run("clickInAnyFrame", async () => {
      const locator = await this.firstVisibleInAnyFrame(selector);
      if (!locator) throw new Error("no frame shows the selector");
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
    });
  }

  async fillInAnyFrame(selector: string, value: string): Promise<void> {
    await this.run("fillInAnyFrame", async () => {
      const locator = await this.firstVisibleInAnyFrame(selector);
      if (!locator) throw new Error("no frame shows the selector");
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
    });
  }

  async readValueInAnyFrame(selector: string): Promise<string | null> {
    return this.run("readValueInAnyFrame", async () => {
      const locator = await this.firstVisibleInAnyFrame(selector);
      if (!locator) return null;
      return locator.evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
          return element.value;
        return element.textContent ?? "";
      });
    });
  }

  async addInitScript(source: string): Promise<void> {
    await this.run("addInitScript", () => this.page.addInitScript(source));
  }

  async exposeBinding(name: string, handler: (payload: unknown) => void): Promise<void> {
    await this.run("exposeBinding", () =>
      this.page.exposeBinding(name, (_source, payload: unknown) => {
        handler(payload);
      })
    );
  }

  onClosed(handler: () => void): void {
    if (this.closed) return;
    this.closedHandlers.push(handler);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.page.close().catch(() => undefined);
      await this.context.close().catch(() => undefined);
      await this.browser.close().catch(() => undefined);
      this.fireClosed();
    })();
    return this.closePromise;
  }
}

export class PlaywrightChromeLauncher implements MeetingBrowserLauncher {
  constructor(private readonly deps: { logger: Logger }) {}

  async open(options: MeetingBrowserOptions): Promise<MeetingPage> {
    const { storageState } = options;
    if (storageState !== null && !isStorageState(storageState)) {
      throw new Error("Browser storage state must be an object with cookies and origins arrays");
    }

    let browser: Browser;
    try {
      browser = await chromium.launch(buildChromeLaunchOptions(options));
    } catch (error) {
      throw sanitizeBrowserError("launch", error);
    }

    try {
      const context = await browser.newContext({
        locale: "en-US",
        permissions: [],
        acceptDownloads: false,
        ...(storageState ? { storageState } : {}),
      });
      const page = await context.newPage();
      this.deps.logger.info("meeting browser opened", {
        channel: options.channel,
        headless: options.headless,
        hasStorageState: storageState !== null,
      });
      return new PlaywrightMeetingPage(browser, context, page);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw sanitizeBrowserError("open", error);
    }
  }
}
