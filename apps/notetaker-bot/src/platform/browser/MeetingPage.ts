// Contract both MeetingPage implementations (the Playwright one and the fake) must honour:
// - close() is idempotent and never rejects, so cleanup paths can call it unconditionally.
// - Closed handlers fire at most once, on any close including the page's own close(). A handler registered
//   after the page closed is not called, so callers must check for a closed page themselves.
// - waitForVisible with timeoutMs <= 0 answers the current visibility at once, and resolves false on timeout.
// - readText is the text of the first match, or null when nothing matches. readTexts is [] when nothing
//   matches. Neither waits and neither trims, so callers decide how to normalise.
// - Methods without `InAnyFrame` see the main frame only.
// - `InAnyFrame` methods look at the main frame first, then child frames in page order, and act on the first frame
//   that shows a visible match. Google Meet can host its chat in a child iframe.
// - waitForVisibleInAnyFrame follows waitForVisible: timeoutMs <= 0 answers at once, and it resolves false on timeout.
// - clickInAnyFrame and fillInAnyFrame do not wait for a match; they reject when no frame shows one.
// - readValueInAnyFrame returns the value of an input or textarea, otherwise the element's text, untrimmed; null
//   when no frame shows a match. It does not wait.
// - readElements returns one entry per element matching `selector` in the main frame, in document order, and []
//   when nothing matches. It does not wait.
// - Its `attributes` hold exactly the requested names; a missing attribute is null. No other attribute is returned.
// - Its `text` is the untrimmed text content of the first element inside the match that matches `innerTextSelector`
//   and is rendered (has a layout box); null when there is none or when `innerTextSelector` is null.
//   `innerTextSelector` is plain CSS because it is evaluated inside the page: no `:visible`, `:has-text` or `:text`.
// - readElements never returns HTML.
// - After the page closed, every async method except close rejects, so a lost browser surfaces as an error.
//   This applies to the `InAnyFrame` methods too.
export type ElementReading = { attributes: Record<string, string | null>; text: string | null };

export interface MeetingPage {
  goto(url: string): Promise<void>;
  currentUrl(): string;
  isVisible(selector: string): Promise<boolean>;
  waitForVisible(selector: string, timeoutMs: number): Promise<boolean>;
  waitForVisibleInAnyFrame(selector: string, timeoutMs: number): Promise<boolean>;
  click(selector: string): Promise<void>;
  clickInAnyFrame(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  fillInAnyFrame(selector: string, value: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  readText(selector: string): Promise<string | null>;
  readTexts(selector: string): Promise<string[]>;
  readElements(
    selector: string,
    attributeNames: readonly string[],
    innerTextSelector: string | null
  ): Promise<ElementReading[]>;
  readValueInAnyFrame(selector: string): Promise<string | null>;
  addInitScript(source: string): Promise<void>;
  exposeBinding(name: string, handler: (payload: unknown) => void): Promise<void>;
  onClosed(handler: () => void): void;
  close(): Promise<void>;
}

export type MeetingBrowserOptions = {
  channel: string;
  headless: boolean;
  storageState: unknown | null;
};

export interface MeetingBrowserLauncher {
  open(options: MeetingBrowserOptions): Promise<MeetingPage>;
}
