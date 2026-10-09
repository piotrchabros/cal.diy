// The Meet probe must see exactly what the bot sees, so it drives the bot's own GoogleMeetAdapter through the bot's
// own launcher. This module wraps that launcher: every page call the adapter makes is recorded as a method, a
// selector key, a count or a boolean and a duration. A selector string, a filled value, a read text or a URL is
// never kept.

import type {
  MeetingBrowserLauncher,
  MeetingBrowserOptions,
  MeetingPage,
} from "../src/platform/browser/MeetingPage";
import { GOOGLE_MEET_SELECTORS } from "../src/platform/GoogleMeetAdapter";
import { isJoinableMeetingUrl } from "../src/platform/meetingUrl";
import type {
  MeetSelectorKey,
  RawAfterLeaveObservation,
  RawPageSample,
  RecordedPageCall,
  RecordedPageMethod,
  RecordedPageResult,
  SelectorSweepResult,
} from "./meetProbeTypes";

type Sleep = (ms: number) => Promise<void>;

type SampleWaiter = {
  accepts: (sample: RawPageSample) => boolean;
  resolve: (sample: RawPageSample | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const VISIBLE_PSEUDO = ":visible";
const IDENTIFIER_CHAR = /[\w-]/;
const VOID_RESULT: RecordedPageResult = { kind: "void" };

// The adapter keeps its own list private; these are the same three dialog buttons.
const DIALOG_KEYS: readonly MeetSelectorKey[] = [
  "dialogContinueWithoutDevices",
  "dialogGotIt",
  "dialogDismiss",
];

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const defaultSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isMeetSelectorKey = (key: string): key is MeetSelectorKey => Object.hasOwn(GOOGLE_MEET_SELECTORS, key);

export const AFTER_LEAVE_OBSERVATION_MS = 3000;
export const AFTER_LEAVE_POLL_MS = 100;
// Counts of a sweep whose read threw; errorName says why.
export const SWEEP_ERROR_COUNT = -1;

// Everything the adapter can meet once the join click is done; the pre-join and sign-in selectors are left out.
export const IN_CALL_SELECTOR_KEYS: readonly MeetSelectorKey[] = [
  "dialogContinueWithoutDevices",
  "dialogGotIt",
  "dialogDismiss",
  "turnOffMicrophone",
  "turnOffCamera",
  "microphoneSettled",
  "cameraSettled",
  "inMeetingMarker",
  "waitingText",
  "deniedText",
  "removedText",
  "endedText",
  "participantCountBadge",
  "participantTile",
  "activeSpeakerName",
  "chatButton",
  "chatInput",
  "chatSendButton",
  "leaveCallButton",
];

// SelectorSweepResult cannot say that a read threw, so the recorder's sweeps carry the error name beside it.
export type ProbeSweepResult = SelectorSweepResult & { errorName: string | null };

// RawPageSample has no receipt time; this keeps it beside the samples, in the same order.
export type ProbeSampleReceipt = { tMs: number; sequence: number };

export type ProbeRecorderSnapshot = {
  pageCalls: RecordedPageCall[];
  samples: RawPageSample[];
  sampleReceipts: ProbeSampleReceipt[];
  droppedSamplePayloads: number;
  selectorSweeps: ProbeSweepResult[];
  afterLeave: RawAfterLeaveObservation | null;
  afterLeaveErrorName: string | null;
};

export type AfterLeaveOptions = { maxMs?: number; pollMs?: number; sleep?: Sleep };

// Quotes are skipped so that text inside :text("...") stays byte-identical.
export function stripVisible(selector: string): string {
  let out = "";
  let quote: string | null = null;
  let index = 0;
  while (index < selector.length) {
    const char = selector.charAt(index);
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (
      selector.startsWith(VISIBLE_PSEUDO, index) &&
      !IDENTIFIER_CHAR.test(selector.charAt(index + VISIBLE_PSEUDO.length))
    ) {
      index += VISIBLE_PSEUDO.length;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const KEY_BY_SELECTOR: ReadonlyMap<string, MeetSelectorKey> = (() => {
  const keys = Object.keys(GOOGLE_MEET_SELECTORS).filter(isMeetSelectorKey);
  const map = new Map<string, MeetSelectorKey>();
  // Exact values go in first so that a stripped form can never shadow another key's real selector.
  for (const key of keys) map.set(GOOGLE_MEET_SELECTORS[key], key);
  for (const key of keys) {
    const stripped = stripVisible(GOOGLE_MEET_SELECTORS[key]);
    if (!map.has(stripped)) map.set(stripped, key);
  }
  return map;
})();

export function selectorKeyOf(selector: string): MeetSelectorKey | null {
  return KEY_BY_SELECTOR.get(selector) ?? null;
}

async function countOrError(
  read: () => Promise<string[]>
): Promise<{ count: number; errorName: string | null }> {
  try {
    return { count: (await read()).length, errorName: null };
  } catch (error) {
    return { count: SWEEP_ERROR_COUNT, errorName: errorNameOf(error) };
  }
}

// A RecordingMeetingPage is unwrapped first: a sweep read through it would show up among the adapter's own calls.
// elapsedMs stamps each result; ProbeRecorder.sweep passes its clock.
export async function sweepSelectors(
  page: MeetingPage,
  keys: readonly MeetSelectorKey[],
  elapsedMs: () => number = () => 0
): Promise<ProbeSweepResult[]> {
  const target = page instanceof RecordingMeetingPage ? page.inner : page;
  const results: ProbeSweepResult[] = [];
  for (const selectorKey of keys) {
    const selector = GOOGLE_MEET_SELECTORS[selectorKey];
    const tMs = elapsedMs();
    const matched = await countOrError(() => target.readTexts(stripVisible(selector)));
    const visible = await countOrError(() => target.readTexts(selector));
    results.push({
      tMs,
      selectorKey,
      matched: matched.count,
      visible: visible.count,
      errorName: matched.errorName ?? visible.errorName,
    });
  }
  return results;
}

export class ProbeRecorder {
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly calls: RecordedPageCall[] = [];
  private readonly pageSamples: RawPageSample[] = [];
  private readonly receipts: ProbeSampleReceipt[] = [];
  private readonly sweeps: ProbeSweepResult[] = [];
  private waiters: SampleWaiter[] = [];
  private droppedSamples = 0;
  private leaveClickDoneMs: number | null = null;
  private afterLeaveObservation: RawAfterLeaveObservation | null = null;
  private afterLeaveError: string | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  recordCall(call: RecordedPageCall): void {
    this.calls.push(call);
    if (call.method === "click" && call.selectorKey === "leaveCallButton" && call.errorName === null) {
      this.leaveClickDoneMs = call.tMs + call.durationMs;
    }
  }

  pageCalls(): RecordedPageCall[] {
    return [...this.calls];
  }

  // When the last successful click on the leave control returned; null when there was none.
  leaveClickCompletedAtMs(): number | null {
    return this.leaveClickDoneMs;
  }

  acceptSample(sample: RawPageSample): void {
    this.pageSamples.push(sample);
    this.receipts.push({ tMs: this.elapsedMs(), sequence: sample.sequence });

    const released = this.waiters.filter((waiter) => waiter.accepts(sample));
    this.waiters = this.waiters.filter((waiter) => !released.includes(waiter));
    for (const waiter of released) {
      clearTimeout(waiter.timer);
      waiter.resolve(sample);
    }
  }

  noteDroppedSamplePayload(): void {
    this.droppedSamples += 1;
  }

  samples(): RawPageSample[] {
    return [...this.pageSamples];
  }

  sampleCount(): number {
    return this.pageSamples.length;
  }

  sampleReceipts(): ProbeSampleReceipt[] {
    return [...this.receipts];
  }

  latestSample(): RawPageSample | null {
    return this.pageSamples.at(-1) ?? null;
  }

  // The next sample to arrive, whatever its number: the collector starts counting again in a new document.
  waitForNextSample(timeoutMs: number): Promise<RawPageSample | null> {
    return this.waitFor(() => true, timeoutMs);
  }

  // Resolves at once when a sample past that number is already held, and with null on timeout.
  waitForSampleAfter(sequence: number, timeoutMs: number): Promise<RawPageSample | null> {
    const held = this.pageSamples.find((sample) => sample.sequence > sequence);
    if (held) return Promise.resolve(held);
    return this.waitFor((sample) => sample.sequence > sequence, timeoutMs);
  }

  async sweep(page: MeetingPage, keys: readonly MeetSelectorKey[]): Promise<ProbeSweepResult[]> {
    const results = await sweepSelectors(page, keys, () => this.elapsedMs());
    this.sweeps.push(...results);
    return results;
  }

  selectorSweeps(): ProbeSweepResult[] {
    return [...this.sweeps];
  }

  setAfterLeave(observation: RawAfterLeaveObservation): void {
    this.afterLeaveObservation = observation;
    this.afterLeaveError = null;
  }

  noteAfterLeaveFailure(errorName: string): void {
    this.afterLeaveError = errorName;
  }

  afterLeave(): RawAfterLeaveObservation | null {
    return this.afterLeaveObservation;
  }

  afterLeaveErrorName(): string | null {
    return this.afterLeaveError;
  }

  snapshot(): ProbeRecorderSnapshot {
    return {
      pageCalls: this.pageCalls(),
      samples: this.samples(),
      sampleReceipts: this.sampleReceipts(),
      droppedSamplePayloads: this.droppedSamples,
      selectorSweeps: this.selectorSweeps(),
      afterLeave: this.afterLeaveObservation,
      afterLeaveErrorName: this.afterLeaveError,
    };
  }

  private waitFor(
    accepts: (sample: RawPageSample) => boolean,
    timeoutMs: number
  ): Promise<RawPageSample | null> {
    return new Promise<RawPageSample | null>((resolve) => {
      const waiter: SampleWaiter = {
        accepts,
        resolve,
        timer: setTimeout(
          () => {
            this.waiters = this.waiters.filter((entry) => entry !== waiter);
            resolve(null);
          },
          Math.max(0, timeoutMs)
        ),
      };
      this.waiters.push(waiter);
    });
  }
}

export class RecordingMeetingPage implements MeetingPage {
  readonly inner: MeetingPage;

  private readonly recorder: ProbeRecorder;
  private readonly maxObservationMs: number;
  private readonly pollMs: number;
  private readonly sleep: Sleep;
  private innerClosed = false;
  private observed = false;

  constructor(deps: { inner: MeetingPage; recorder: ProbeRecorder; afterLeave?: AfterLeaveOptions }) {
    this.inner = deps.inner;
    this.recorder = deps.recorder;
    this.maxObservationMs = deps.afterLeave?.maxMs ?? AFTER_LEAVE_OBSERVATION_MS;
    this.pollMs = Math.max(1, deps.afterLeave?.pollMs ?? AFTER_LEAVE_POLL_MS);
    this.sleep = deps.afterLeave?.sleep ?? defaultSleep;
    this.inner.onClosed(() => {
      this.innerClosed = true;
    });
  }

  goto(url: string): Promise<void> {
    return this.recorded("goto", null, () => this.inner.goto(url));
  }

  currentUrl(): string {
    const tMs = this.recorder.elapsedMs();
    try {
      const url = this.inner.currentUrl();
      this.record("currentUrl", null, tMs, VOID_RESULT, null);
      return url;
    } catch (error) {
      this.record("currentUrl", null, tMs, null, errorNameOf(error));
      throw error;
    }
  }

  isVisible(selector: string): Promise<boolean> {
    return this.recorded(
      "isVisible",
      selector,
      () => this.inner.isVisible(selector),
      (value) => ({ kind: "boolean", value })
    );
  }

  waitForVisible(selector: string, timeoutMs: number): Promise<boolean> {
    return this.recorded(
      "waitForVisible",
      selector,
      () => this.inner.waitForVisible(selector, timeoutMs),
      (value) => ({ kind: "boolean", value })
    );
  }

  click(selector: string): Promise<void> {
    return this.recorded("click", selector, () => this.inner.click(selector));
  }

  fill(selector: string, value: string): Promise<void> {
    return this.recorded("fill", selector, () => this.inner.fill(selector, value));
  }

  pressKey(key: string): Promise<void> {
    return this.recorded("pressKey", null, () => this.inner.pressKey(key));
  }

  readText(selector: string): Promise<string | null> {
    return this.recorded(
      "readText",
      selector,
      () => this.inner.readText(selector),
      (text) => ({ kind: "found", value: text !== null })
    );
  }

  readTexts(selector: string): Promise<string[]> {
    return this.recorded(
      "readTexts",
      selector,
      () => this.inner.readTexts(selector),
      (texts) => ({ kind: "count", value: texts.length })
    );
  }

  waitForVisibleInAnyFrame(selector: string, timeoutMs: number): Promise<boolean> {
    return this.recorded(
      "waitForVisibleInAnyFrame",
      selector,
      () => this.inner.waitForVisibleInAnyFrame(selector, timeoutMs),
      (value) => ({ kind: "boolean", value })
    );
  }

  clickInAnyFrame(selector: string): Promise<void> {
    return this.recorded("clickInAnyFrame", selector, () => this.inner.clickInAnyFrame(selector));
  }

  fillInAnyFrame(selector: string, value: string): Promise<void> {
    return this.recorded("fillInAnyFrame", selector, () => this.inner.fillInAnyFrame(selector, value));
  }

  readValueInAnyFrame(selector: string): Promise<string | null> {
    return this.recorded(
      "readValueInAnyFrame",
      selector,
      () => this.inner.readValueInAnyFrame(selector),
      (value) => ({ kind: "found", value: value !== null })
    );
  }

  addInitScript(source: string): Promise<void> {
    return this.recorded("addInitScript", null, () => this.inner.addInitScript(source));
  }

  exposeBinding(name: string, handler: (payload: unknown) => void): Promise<void> {
    return this.recorded("exposeBinding", null, () => this.inner.exposeBinding(name, handler));
  }

  onClosed(handler: () => void): void {
    const tMs = this.recorder.elapsedMs();
    try {
      this.inner.onClosed(handler);
      this.record("onClosed", null, tMs, VOID_RESULT, null);
    } catch (error) {
      this.record("onClosed", null, tMs, null, errorNameOf(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.observed) {
      this.observed = true;
      try {
        this.recorder.setAfterLeave(await this.observeAfterLeave());
      } catch (error) {
        this.recorder.noteAfterLeaveFailure(errorNameOf(error));
      }
    }
    // Recorded from here, not from the adapter's call, so the entry times the real close and not the observation.
    await this.recorded("close", null, () => this.inner.close());
  }

  private record(
    method: RecordedPageMethod,
    selector: string | null,
    tMs: number,
    result: RecordedPageResult | null,
    errorName: string | null
  ): void {
    this.recorder.recordCall({
      tMs,
      method,
      selectorKey: selector === null ? null : selectorKeyOf(selector),
      result,
      errorName,
      durationMs: this.recorder.elapsedMs() - tMs,
    });
  }

  private async recorded<T>(
    method: RecordedPageMethod,
    selector: string | null,
    run: () => Promise<T>,
    toResult: (value: T) => RecordedPageResult = () => VOID_RESULT
  ): Promise<T> {
    const tMs = this.recorder.elapsedMs();
    let value: T;
    try {
      value = await run();
    } catch (error) {
      this.record(method, selector, tMs, null, errorNameOf(error));
      throw error;
    }
    this.record(method, selector, tMs, toResult(value), null);
    return value;
  }

  // A page that is already gone rejects every read, and that only means "not visible" here.
  private async visibleQuietly(key: MeetSelectorKey): Promise<boolean> {
    if (this.innerClosed) return false;
    try {
      return await this.inner.isVisible(GOOGLE_MEET_SELECTORS[key]);
    } catch {
      return false;
    }
  }

  private urlKind(): RawAfterLeaveObservation["urlKind"] {
    let url: string;
    try {
      url = this.inner.currentUrl();
    } catch {
      return "other";
    }
    if (url === "" || url === "about:blank") return "blank";
    return isJoinableMeetingUrl("GOOGLE_MEET", url) ? "meeting" : "other";
  }

  // Reads go to the inner page so they do not mix with the adapter's recorded calls.
  private async observeAfterLeave(): Promise<RawAfterLeaveObservation> {
    const startMs = this.recorder.elapsedMs();
    const firstSampleIndex = this.recorder.sampleCount();
    const samplesSoFar = (): RawPageSample[] =>
      this.recorder.samples().slice(firstSampleIndex, firstSampleIndex + 2);
    let endedAtMs: number | null = null;

    // Bounded by a poll count as well as by the clock, so an injected clock that stands still cannot hang close().
    const maxPolls = Math.ceil(this.maxObservationMs / this.pollMs) + 1;
    for (let poll = 0; poll < maxPolls && !this.innerClosed; poll += 1) {
      if (endedAtMs === null && (await this.visibleQuietly("endedText"))) {
        endedAtMs = this.recorder.elapsedMs();
      }
      if (endedAtMs !== null && samplesSoFar().length >= 2) break;
      const remainingMs = this.maxObservationMs - (this.recorder.elapsedMs() - startMs);
      if (remainingMs <= 0) break;
      await this.sleep(Math.min(this.pollMs, remainingMs));
    }

    const dialogKeysVisible: MeetSelectorKey[] = [];
    for (const key of DIALOG_KEYS) {
      if (await this.visibleQuietly(key)) dialogKeysVisible.push(key);
    }
    const clickDoneMs = this.recorder.leaveClickCompletedAtMs();

    return {
      observedMs: this.recorder.elapsedMs() - startMs,
      endedTextVisible: endedAtMs !== null,
      leaveCallButtonVisible: await this.visibleQuietly("leaveCallButton"),
      inMeetingMarkerVisible: await this.visibleQuietly("inMeetingMarker"),
      dialogKeysVisible,
      urlKind: this.urlKind(),
      msFromClickToEndedText:
        endedAtMs !== null && clickDoneMs !== null ? Math.max(0, endedAtMs - clickDoneMs) : null,
      samples: samplesSoFar(),
    };
  }
}

export class ProbeBrowserLauncher implements MeetingBrowserLauncher {
  private readonly innerLauncher: MeetingBrowserLauncher;
  private readonly recorder: ProbeRecorder;
  private readonly initScript: string;
  private readonly bindingName: string;
  private readonly decodeSample: (payload: unknown) => RawPageSample | null;
  private readonly afterLeave: AfterLeaveOptions | undefined;
  private readonly handedOut: RecordingMeetingPage[] = [];

  constructor(deps: {
    inner: MeetingBrowserLauncher;
    recorder: ProbeRecorder;
    initScript: string;
    bindingName: string;
    decodeSample: (payload: unknown) => RawPageSample | null;
    afterLeave?: AfterLeaveOptions;
  }) {
    this.innerLauncher = deps.inner;
    this.recorder = deps.recorder;
    this.initScript = deps.initScript;
    this.bindingName = deps.bindingName;
    this.decodeSample = deps.decodeSample;
    this.afterLeave = deps.afterLeave;
  }

  // The page the adapter is using, for sweeps; null before the first open.
  currentPage(): RecordingMeetingPage | null {
    return this.handedOut.at(-1) ?? null;
  }

  async open(options: MeetingBrowserOptions): Promise<RecordingMeetingPage> {
    const inner = await this.innerLauncher.open(options);
    // Installed on the inner page, before the adapter sees it: the collector is in place ahead of any navigation
    // and stays out of the adapter's recorded calls. Its binding name differs from the adapter's two.
    try {
      await inner.addInitScript(this.initScript);
      await inner.exposeBinding(this.bindingName, (payload) => this.handleSamplePayload(payload));
    } catch (error) {
      await inner.close().catch(() => {});
      throw error;
    }
    const page = new RecordingMeetingPage({ inner, recorder: this.recorder, afterLeave: this.afterLeave });
    this.handedOut.push(page);
    return page;
  }

  private handleSamplePayload(payload: unknown): void {
    const sample = this.decodeSample(payload);
    if (sample) this.recorder.acceptSample(sample);
    else this.recorder.noteDroppedSamplePayload();
  }
}
