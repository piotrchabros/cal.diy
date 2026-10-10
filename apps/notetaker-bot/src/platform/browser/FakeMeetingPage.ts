import type {
  ElementReading,
  MeetingBrowserLauncher,
  MeetingBrowserOptions,
  MeetingPage,
} from "./MeetingPage";

type PendingWaiter = {
  selector: string;
  anyFrame: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (visible: boolean) => void;
  reject: (error: Error) => void;
};

const CLOSED_MESSAGE = "FakeMeetingPage: page is closed";

type FakeMeetingBrowserLauncherOptions = {
  pages?: FakeMeetingPage[];
  openError?: Error;
  openDelayMs?: number;
};

export type FakeElementRow = { attributes?: Record<string, string | null>; text?: string | null };

export type FakePageAction =
  | { type: "goto"; url: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "clickInAnyFrame"; selector: string }
  | { type: "fillInAnyFrame"; selector: string; value: string }
  | { type: "pressKey"; key: string }
  | { type: "addInitScript"; source: string }
  | { type: "exposeBinding"; name: string }
  | { type: "close" };

export type FakePageMethod =
  | "goto"
  | "isVisible"
  | "waitForVisible"
  | "waitForVisibleInAnyFrame"
  | "click"
  | "clickInAnyFrame"
  | "fill"
  | "fillInAnyFrame"
  | "readValueInAnyFrame"
  | "pressKey"
  | "readText"
  | "readTexts"
  | "readElements"
  | "addInitScript"
  | "exposeBinding"
  | "close";

export class FakeMeetingPage implements MeetingPage {
  readonly actions: FakePageAction[] = [];
  readonly initScripts: string[] = [];
  closeCalls = 0;

  private url: string;
  private isClosed = false;
  private readonly visible = new Map<string, boolean>();
  private readonly childFrameVisible = new Map<string, boolean>();
  private readonly values = new Map<string, string>();
  private readonly texts = new Map<string, string | null>();
  private readonly textLists = new Map<string, string[]>();
  private readonly elementRows = new Map<string, FakeElementRow[]>();
  private readonly methodErrors = new Map<FakePageMethod, Error>();
  private readonly selectorErrors = new Map<string, Error>();
  private readonly bindings = new Map<string, (payload: unknown) => void>();
  private readonly actionListeners: ((action: FakePageAction) => void)[] = [];
  private closedHandlers: (() => void)[] = [];
  private waiters: PendingWaiter[] = [];

  constructor(options: { url?: string } = {}) {
    this.url = options.url ?? "about:blank";
  }

  get closed(): boolean {
    return this.isClosed;
  }

  hasBinding(name: string): boolean {
    return this.bindings.has(name);
  }

  setUrl(url: string): void {
    this.url = url;
  }

  setVisible(selector: string, visible = true): void {
    this.visible.set(selector, visible);
    if (visible) this.releaseWaiters(selector, true);
  }

  setVisibleInChildFrame(selector: string, visible = true): void {
    this.childFrameVisible.set(selector, visible);
    if (visible) this.releaseWaiters(selector, false);
  }

  setValue(selector: string, value: string): void {
    this.values.set(selector, value);
  }

  setText(selector: string, text: string | null): void {
    this.texts.set(selector, text);
  }

  setTexts(selector: string, texts: string[]): void {
    this.textLists.set(selector, [...texts]);
  }

  setElements(selector: string, rows: FakeElementRow[]): void {
    this.elementRows.set(
      selector,
      rows.map((row) => ({ attributes: { ...row.attributes }, text: row.text }))
    );
  }

  setError(method: FakePageMethod, error: Error | null): void {
    if (error) this.methodErrors.set(method, error);
    else this.methodErrors.delete(method);
  }

  setSelectorError(selector: string, error: Error | null): void {
    if (error) this.selectorErrors.set(selector, error);
    else this.selectorErrors.delete(selector);
  }

  onAction(listener: (action: FakePageAction) => void): void {
    this.actionListeners.push(listener);
  }

  triggerBinding(name: string, payload: unknown): void {
    const handler = this.bindings.get(name);
    if (!handler) throw new Error(`FakeMeetingPage: no binding named ${name} is exposed`);
    handler(payload);
  }

  triggerClosed(): void {
    this.markClosed();
  }

  async goto(url: string): Promise<void> {
    this.beginMutation({ type: "goto", url }, "goto");
    this.url = url;
  }

  currentUrl(): string {
    return this.url;
  }

  async isVisible(selector: string): Promise<boolean> {
    this.beginRead("isVisible", selector);
    return this.visible.get(selector) ?? false;
  }

  waitForVisible(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      this.beginRead("waitForVisible", selector);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.waitFor(selector, timeoutMs, false);
  }

  waitForVisibleInAnyFrame(selector: string, timeoutMs: number): Promise<boolean> {
    try {
      this.beginRead("waitForVisibleInAnyFrame", selector);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.waitFor(selector, timeoutMs, true);
  }

  private waitFor(selector: string, timeoutMs: number, anyFrame: boolean): Promise<boolean> {
    const current = this.isShowing(selector, anyFrame);
    if (current || timeoutMs <= 0) return Promise.resolve(current);

    return new Promise<boolean>((resolve, reject) => {
      const waiter: PendingWaiter = {
        selector,
        anyFrame,
        timer: null,
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async click(selector: string): Promise<void> {
    this.beginMutation({ type: "click", selector }, "click", selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    this.beginMutation({ type: "fill", selector, value }, "fill", selector);
  }

  async clickInAnyFrame(selector: string): Promise<void> {
    this.requireInAnyFrame(selector);
    this.beginMutation({ type: "clickInAnyFrame", selector }, "clickInAnyFrame", selector);
  }

  async fillInAnyFrame(selector: string, value: string): Promise<void> {
    this.requireInAnyFrame(selector);
    // Stored before the action is recorded so an onAction listener can overwrite it; a scripted error stores nothing.
    const scripted = this.scriptedError("fillInAnyFrame", selector);
    if (!scripted) this.values.set(selector, value);
    this.record({ type: "fillInAnyFrame", selector, value });
    if (scripted) throw scripted;
  }

  async readValueInAnyFrame(selector: string): Promise<string | null> {
    this.beginRead("readValueInAnyFrame", selector);
    if (!this.isShowing(selector, true)) return null;
    return this.values.get(selector) ?? "";
  }

  async pressKey(key: string): Promise<void> {
    this.beginMutation({ type: "pressKey", key }, "pressKey");
  }

  async readText(selector: string): Promise<string | null> {
    this.beginRead("readText", selector);
    return this.texts.get(selector) ?? null;
  }

  async readTexts(selector: string): Promise<string[]> {
    this.beginRead("readTexts", selector);
    return [...(this.textLists.get(selector) ?? [])];
  }

  async readElements(
    selector: string,
    attributeNames: readonly string[],
    innerTextSelector: string | null
  ): Promise<ElementReading[]> {
    this.beginRead("readElements", selector);
    return (this.elementRows.get(selector) ?? []).map((row) => {
      const attributes: Record<string, string | null> = {};
      for (const name of attributeNames) attributes[name] = row.attributes?.[name] ?? null;
      return { attributes, text: innerTextSelector === null ? null : (row.text ?? null) };
    });
  }

  async addInitScript(source: string): Promise<void> {
    this.beginMutation({ type: "addInitScript", source }, "addInitScript");
    this.initScripts.push(source);
  }

  async exposeBinding(name: string, handler: (payload: unknown) => void): Promise<void> {
    this.beginMutation({ type: "exposeBinding", name }, "exposeBinding");
    if (this.bindings.has(name)) throw new Error(`FakeMeetingPage: binding ${name} is already exposed`);
    this.bindings.set(name, handler);
  }

  onClosed(handler: () => void): void {
    if (this.isClosed) return;
    this.closedHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.record({ type: "close" });
    this.markClosed();
    const error = this.methodErrors.get("close");
    if (error) throw error;
  }

  private record(action: FakePageAction): void {
    this.actions.push(action);
    for (const listener of this.actionListeners) listener(action);
  }

  private beginMutation(action: FakePageAction, method: FakePageMethod, selector?: string): void {
    if (this.isClosed) throw new Error(CLOSED_MESSAGE);
    this.record(action);
    this.throwScriptedError(method, selector);
  }

  private beginRead(method: FakePageMethod, selector: string): void {
    if (this.isClosed) throw new Error(CLOSED_MESSAGE);
    this.throwScriptedError(method, selector);
  }

  private throwScriptedError(method: FakePageMethod, selector: string | undefined): void {
    const error = this.scriptedError(method, selector);
    if (error) throw error;
  }

  private scriptedError(method: FakePageMethod, selector: string | undefined): Error | null {
    const methodError = this.methodErrors.get(method);
    if (methodError) return methodError;
    if (selector === undefined) return null;

    return this.selectorErrors.get(selector) ?? null;
  }

  private isShowing(selector: string, anyFrame: boolean): boolean {
    if (this.visible.get(selector)) return true;
    return anyFrame && (this.childFrameVisible.get(selector) ?? false);
  }

  private requireInAnyFrame(selector: string): void {
    if (this.isClosed) throw new Error(CLOSED_MESSAGE);
    if (!this.isShowing(selector, true)) throw new Error(`FakeMeetingPage: no frame shows ${selector}`);
  }

  private releaseWaiters(selector: string, includeMainFrame: boolean): void {
    const matches = (waiter: PendingWaiter) =>
      waiter.selector === selector && (waiter.anyFrame || includeMainFrame);
    const released = this.waiters.filter(matches);
    this.waiters = this.waiters.filter((waiter) => !matches(waiter));
    for (const waiter of released) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  private markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error(CLOSED_MESSAGE));
    }

    const handlers = this.closedHandlers;
    this.closedHandlers = [];
    for (const handler of handlers) handler();
  }
}

export class FakeMeetingBrowserLauncher implements MeetingBrowserLauncher {
  readonly pages: FakeMeetingPage[] = [];
  readonly openCalls: MeetingBrowserOptions[] = [];

  private readonly queue: FakeMeetingPage[];
  private openError: Error | null;
  private openDelayMs: number;

  constructor(options: FakeMeetingBrowserLauncherOptions = {}) {
    this.queue = [...(options.pages ?? [])];
    this.openError = options.openError ?? null;
    this.openDelayMs = options.openDelayMs ?? 0;
  }

  page(index: number): FakeMeetingPage {
    const page = this.pages[index];
    if (!page) {
      throw new Error(
        `FakeMeetingBrowserLauncher: no page at index ${index}, ${this.pages.length} handed out so far`
      );
    }
    return page;
  }

  enqueuePage(page: FakeMeetingPage): void {
    this.queue.push(page);
  }

  setOpenError(error: Error | null): void {
    this.openError = error;
  }

  setOpenDelayMs(delayMs: number): void {
    this.openDelayMs = delayMs;
  }

  async open(options: MeetingBrowserOptions): Promise<FakeMeetingPage> {
    this.openCalls.push({ ...options });
    if (this.openDelayMs > 0) {
      const delayMs = this.openDelayMs;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    if (this.openError) throw this.openError;

    const page = this.queue.shift() ?? new FakeMeetingPage();
    this.pages.push(page);
    return page;
  }
}
