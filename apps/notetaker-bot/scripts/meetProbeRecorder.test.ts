// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_FRAME_BINDING, SOURCE_ACTIVITY_BINDING } from "../src/audio/captureScript";
import type { RunnerConfig } from "../src/config";
import { createSilentLogger } from "../src/logger";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/platform/browser/BrowserPlatformAdapter";
import { FakeMeetingBrowserLauncher, FakeMeetingPage } from "../src/platform/browser/FakeMeetingPage";
import { GOOGLE_MEET_SELECTORS, GoogleMeetAdapter } from "../src/platform/GoogleMeetAdapter";
import type { PlatformEvent, PlatformHandlers } from "../src/platform/PlatformAdapter";
import {
  AFTER_LEAVE_OBSERVATION_MS,
  IN_CALL_SELECTOR_KEYS,
  ProbeBrowserLauncher,
  ProbeRecorder,
  RecordingMeetingPage,
  SWEEP_ERROR_COUNT,
  selectorKeyOf,
  stripVisible,
  sweepSelectors,
} from "./meetProbeRecorder";
import type { MeetSelectorKey, RawPageSample, RecordedPageCall } from "./meetProbeTypes";

const S = GOOGLE_MEET_SELECTORS;
const FAKE_URL = "https://meet.google.com/abc-defg-hij";
const FAKE_NAME = "Fake Notetaker Name";
const FAKE_FILL = "fake-filled-value";
const FAKE_TEXT = "Ada Lovelace";
const FAKE_KEY = "Enter";
const FAKE_INIT_SCRIPT = "/* fake probe init script */";
const FAKE_BINDING = "__fakeProbeSample";
const GUEST: RunnerConfig["google"] = { joinMode: "guest", storageState: null, email: null, password: null };
const CHROME: RunnerConfig["chrome"] = { channel: "fake-channel", headless: true };
const BROWSER_OPTIONS = { channel: "fake-channel", headless: true, storageState: null };

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function sample(sequence: number): RawPageSample {
  return {
    sequence,
    pageTimeMs: sequence * 1000,
    leaveControls: [],
    tiles: [],
    selectorChecks: [],
    rtc: { peerConnectionCount: 0, receivers: [] },
    visibilityState: "visible",
    hasFocus: true,
    dialogCount: 0,
    dialogs: [],
  };
}

// Stands in for decodeProbeSamplePayload: a number is a sample, anything else is refused.
const decodeFakeSample = (payload: unknown): RawPageSample | null =>
  typeof payload === "number" ? sample(payload) : null;

function setupPage(afterLeave = { maxMs: 0 }) {
  const inner = new FakeMeetingPage();
  const recorder = new ProbeRecorder();
  const page = new RecordingMeetingPage({ inner, recorder, afterLeave });
  return { inner, recorder, page };
}

function setupLauncher(inner = new FakeMeetingPage()) {
  const recorder = new ProbeRecorder();
  const fakeLauncher = new FakeMeetingBrowserLauncher({ pages: [inner] });
  const launcher = new ProbeBrowserLauncher({
    inner: fakeLauncher,
    recorder,
    initScript: FAKE_INIT_SCRIPT,
    bindingName: FAKE_BINDING,
    decodeSample: decodeFakeSample,
  });
  return { inner, recorder, fakeLauncher, launcher };
}

const shape = (call: RecordedPageCall | undefined) =>
  call && {
    method: call.method,
    selectorKey: call.selectorKey,
    result: call.result,
    errorName: call.errorName,
  };

class FakeTimeoutError extends Error {
  constructor() {
    super(`waiting for ${S.leaveCallButton} at ${FAKE_URL}`);
    this.name = "TimeoutError";
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stripVisible", () => {
  it("removes :visible from every alternative and keeps the rest byte-identical", () => {
    expect(stripVisible('a[x="1"]:visible, button:has-text("Go"):visible')).toBe(
      'a[x="1"], button:has-text("Go")'
    );
    expect(stripVisible(S.leaveCallButton)).toBe('button[aria-label*="Leave call" i]');
    expect(stripVisible(S.activeSpeakerName)).toBe(
      '[data-participant-id]:has([aria-label*="speaking" i]) span.notranslate'
    );
  });

  it("leaves a selector without the pseudo-class untouched", () => {
    expect(stripVisible('button[aria-label="People"] ~ div')).toBe('button[aria-label="People"] ~ div');
    expect(stripVisible("")).toBe("");
  });

  it("does not touch quoted text or a longer pseudo-class name", () => {
    expect(stripVisible(':text("is :visible now"):visible')).toBe(':text("is :visible now")');
    expect(stripVisible("div:visible-ish, span:visible")).toBe("div:visible-ish, span");
  });

  it("strips every adapter selector down to a selector with no :visible left outside quotes", () => {
    for (const selector of Object.values(S)) {
      const stripped = stripVisible(selector);
      expect(stripped).not.toContain(":visible");
      expect(stripped.length).toBeLessThan(selector.length);
    }
  });
});

describe("selectorKeyOf", () => {
  it("finds the key of every adapter selector, with and without :visible", () => {
    for (const [key, selector] of Object.entries(S)) {
      expect(selectorKeyOf(selector)).toBe(key);
      expect(selectorKeyOf(stripVisible(selector))).toBe(key);
    }
  });

  it("is null for anything that is not an adapter selector", () => {
    expect(selectorKeyOf('button[aria-label="Something else"]')).toBeNull();
    expect(selectorKeyOf("")).toBeNull();
    expect(selectorKeyOf("leaveCallButton")).toBeNull();
  });
});

describe("RecordingMeetingPage", () => {
  it("delegates every method and records it with the right key and result kind", async () => {
    const { inner, recorder, page } = setupPage();
    const closedHandler = vi.fn();
    inner.setVisible(S.leaveCallButton);
    inner.setVisible(S.chatInput);
    inner.setText(S.participantCountBadge, "3");
    inner.setTexts(S.activeSpeakerName, [FAKE_TEXT, "Grace Hopper"]);

    page.onClosed(closedHandler);
    await page.addInitScript("/* adapter script */");
    await page.exposeBinding("adapterBinding", () => {});
    await page.goto(FAKE_URL);
    expect(page.currentUrl()).toBe(FAKE_URL);
    expect(await page.isVisible(S.leaveCallButton)).toBe(true);
    expect(await page.isVisible(S.endedText)).toBe(false);
    expect(await page.waitForVisible(S.chatInput, 1000)).toBe(true);
    await page.click(S.chatButton);
    await page.fill(S.chatInput, FAKE_FILL);
    await page.pressKey(FAKE_KEY);
    expect(await page.readText(S.participantCountBadge)).toBe("3");
    expect(await page.readText(S.waitingText)).toBeNull();
    expect(await page.readTexts(S.activeSpeakerName)).toEqual([FAKE_TEXT, "Grace Hopper"]);
    expect(await page.readTexts("div.not-an-adapter-selector")).toEqual([]);
    await page.close();

    expect(inner.actions).toEqual([
      { type: "addInitScript", source: "/* adapter script */" },
      { type: "exposeBinding", name: "adapterBinding" },
      { type: "goto", url: FAKE_URL },
      { type: "click", selector: S.chatButton },
      { type: "fill", selector: S.chatInput, value: FAKE_FILL },
      { type: "pressKey", key: FAKE_KEY },
      { type: "close" },
    ]);
    expect(inner.hasBinding("adapterBinding")).toBe(true);
    expect(closedHandler).toHaveBeenCalledTimes(1);

    const ok = (
      method: RecordedPageCall["method"],
      selectorKey: MeetSelectorKey | null,
      result: RecordedPageCall["result"] = { kind: "void" }
    ) => ({ method, selectorKey, result, errorName: null });
    expect(recorder.pageCalls().map(shape)).toEqual([
      ok("onClosed", null),
      ok("addInitScript", null),
      ok("exposeBinding", null),
      ok("goto", null),
      ok("currentUrl", null),
      ok("isVisible", "leaveCallButton", { kind: "boolean", value: true }),
      ok("isVisible", "endedText", { kind: "boolean", value: false }),
      ok("waitForVisible", "chatInput", { kind: "boolean", value: true }),
      ok("click", "chatButton"),
      ok("fill", "chatInput"),
      ok("pressKey", null),
      ok("readText", "participantCountBadge", { kind: "found", value: true }),
      ok("readText", "waitingText", { kind: "found", value: false }),
      ok("readTexts", "activeSpeakerName", { kind: "count", value: 2 }),
      ok("readTexts", null, { kind: "count", value: 0 }),
      ok("close", null),
    ]);
  });

  it("forwards the any-frame methods and records the selector key, never the value", async () => {
    const { inner, recorder, page } = setupPage();
    inner.setVisibleInChildFrame(S.chatInput);
    inner.setVisibleInChildFrame(S.chatSendButton);

    expect(await page.waitForVisibleInAnyFrame(S.chatInput, 1000)).toBe(true);
    expect(await page.readValueInAnyFrame(S.chatInput)).toBe("");
    await page.fillInAnyFrame(S.chatInput, FAKE_FILL);
    expect(await page.readValueInAnyFrame(S.chatInput)).toBe(FAKE_FILL);
    await page.clickInAnyFrame(S.chatSendButton);
    expect(await page.readValueInAnyFrame(S.chatButton)).toBeNull();

    expect(inner.actions).toEqual([
      { type: "fillInAnyFrame", selector: S.chatInput, value: FAKE_FILL },
      { type: "clickInAnyFrame", selector: S.chatSendButton },
    ]);
    expect(recorder.pageCalls().map(shape)).toEqual([
      {
        method: "waitForVisibleInAnyFrame",
        selectorKey: "chatInput",
        result: { kind: "boolean", value: true },
        errorName: null,
      },
      {
        method: "readValueInAnyFrame",
        selectorKey: "chatInput",
        result: { kind: "found", value: true },
        errorName: null,
      },
      { method: "fillInAnyFrame", selectorKey: "chatInput", result: { kind: "void" }, errorName: null },
      {
        method: "readValueInAnyFrame",
        selectorKey: "chatInput",
        result: { kind: "found", value: true },
        errorName: null,
      },
      { method: "clickInAnyFrame", selectorKey: "chatSendButton", result: { kind: "void" }, errorName: null },
      {
        method: "readValueInAnyFrame",
        selectorKey: "chatButton",
        result: { kind: "found", value: false },
        errorName: null,
      },
    ]);
    expect(JSON.stringify(recorder.pageCalls())).not.toContain(FAKE_FILL);
  });

  it("records the start time and the duration of a call", async () => {
    const { inner, recorder, page } = setupPage();
    await advance(700);

    const waiting = page.waitForVisible(S.chatInput, 5000);
    await advance(1200);
    inner.setVisible(S.chatInput);
    await waiting;

    expect(recorder.pageCalls().at(-1)).toEqual({
      tMs: 700,
      method: "waitForVisible",
      selectorKey: "chatInput",
      result: { kind: "boolean", value: true },
      errorName: null,
      durationMs: 1200,
    });
  });

  it("records an error by class name only and rethrows it unchanged", async () => {
    const { inner, recorder, page } = setupPage();
    const error = new FakeTimeoutError();
    inner.setSelectorError(S.leaveCallButton, error);

    await expect(page.click(S.leaveCallButton)).rejects.toBe(error);
    await expect(page.isVisible(S.leaveCallButton)).rejects.toBe(error);

    expect(recorder.pageCalls().map(shape)).toEqual([
      { method: "click", selectorKey: "leaveCallButton", result: null, errorName: "TimeoutError" },
      { method: "isVisible", selectorKey: "leaveCallButton", result: null, errorName: "TimeoutError" },
    ]);
    expect(recorder.leaveClickCompletedAtMs()).toBeNull();
  });

  it("names a thrown non-error value unknown", async () => {
    const { inner, recorder, page } = setupPage();
    vi.spyOn(inner, "pressKey").mockRejectedValue("plain string");

    await expect(page.pressKey(FAKE_KEY)).rejects.toBe("plain string");

    expect(recorder.pageCalls().map(shape)).toEqual([
      { method: "pressKey", selectorKey: null, result: null, errorName: "unknown" },
    ]);
  });

  it("stores no selector string, filled value, read text, key or URL", async () => {
    const { inner, recorder, page } = setupPage({ maxMs: 300 });
    inner.setVisible(S.leaveCallButton);
    inner.setText(S.participantCountBadge, FAKE_TEXT);
    inner.setTexts(S.activeSpeakerName, [FAKE_TEXT]);
    inner.setSelectorError(S.chatSendButton, new FakeTimeoutError());

    await page.addInitScript(FAKE_INIT_SCRIPT);
    await page.exposeBinding(FAKE_BINDING, () => {});
    await page.goto(FAKE_URL);
    page.currentUrl();
    await page.isVisible(S.leaveCallButton);
    await page.waitForVisible(S.leaveCallButton, 0);
    await page.fill(S.guestNameInput, FAKE_NAME);
    await page.fill(S.chatInput, FAKE_FILL);
    await page.pressKey(FAKE_KEY);
    await page.readText(S.participantCountBadge);
    await page.readTexts(S.activeSpeakerName);
    await page.readTexts("div.unknown-selector");
    await page.click(S.chatSendButton).catch(() => {});
    await page.click(S.leaveCallButton);
    await recorder.sweep(page, IN_CALL_SELECTOR_KEYS);
    const closing = page.close();
    await advance(300);
    await closing;

    const json = JSON.stringify(recorder.snapshot());
    for (const selector of Object.values(S)) {
      expect(json).not.toContain(JSON.stringify(selector).slice(1, -1));
      expect(json).not.toContain(JSON.stringify(stripVisible(selector)).slice(1, -1));
    }
    for (const secret of [
      FAKE_URL,
      "meet.google.com",
      "abc-defg-hij",
      FAKE_NAME,
      FAKE_FILL,
      FAKE_TEXT,
      FAKE_KEY,
      FAKE_INIT_SCRIPT,
      FAKE_BINDING,
      "unknown-selector",
      "waiting for",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(recorder.afterLeave()?.urlKind).toBe("meeting");
  });
});

describe("sweepSelectors", () => {
  it("counts matched without :visible and visible with it, keeping only the counts", async () => {
    const inner = new FakeMeetingPage();
    inner.setTexts(stripVisible(S.activeSpeakerName), [FAKE_TEXT, "Grace Hopper", "Alan Turing"]);
    inner.setTexts(S.activeSpeakerName, [FAKE_TEXT]);
    inner.setTexts(stripVisible(S.leaveCallButton), ["call_end"]);

    const results = await sweepSelectors(inner, ["activeSpeakerName", "leaveCallButton", "endedText"]);

    expect(results).toEqual([
      { tMs: 0, selectorKey: "activeSpeakerName", matched: 3, visible: 1, errorName: null },
      { tMs: 0, selectorKey: "leaveCallButton", matched: 1, visible: 0, errorName: null },
      { tMs: 0, selectorKey: "endedText", matched: 0, visible: 0, errorName: null },
    ]);
    expect(JSON.stringify(results)).not.toContain(FAKE_TEXT);
  });

  it("records a selector that throws as an error result and carries on", async () => {
    const inner = new FakeMeetingPage();
    inner.setSelectorError(S.participantTile, new FakeTimeoutError());
    inner.setTexts(S.chatButton, ["chat"]);
    inner.setTexts(stripVisible(S.chatButton), ["chat"]);

    const results = await sweepSelectors(inner, ["participantTile", "chatButton"]);

    expect(results).toEqual([
      {
        tMs: 0,
        selectorKey: "participantTile",
        matched: 0,
        visible: SWEEP_ERROR_COUNT,
        errorName: "TimeoutError",
      },
      { tMs: 0, selectorKey: "chatButton", matched: 1, visible: 1, errorName: null },
    ]);
  });

  it("reports every key as an error on a page that is gone", async () => {
    const inner = new FakeMeetingPage();
    await inner.close();

    const results = await sweepSelectors(inner, IN_CALL_SELECTOR_KEYS);

    expect(results.map((result) => result.selectorKey)).toEqual([...IN_CALL_SELECTOR_KEYS]);
    expect(
      results.every((result) => result.matched === SWEEP_ERROR_COUNT && result.errorName === "Error")
    ).toBe(true);
  });

  it("goes through the inner page, so a sweep adds no recorded adapter call", async () => {
    const { inner, recorder, page } = setupPage();
    inner.setTexts(S.inMeetingMarker, ["details"]);
    await advance(450);

    const results = await recorder.sweep(page, ["inMeetingMarker"]);

    expect(results).toEqual([
      { tMs: 450, selectorKey: "inMeetingMarker", matched: 0, visible: 1, errorName: null },
    ]);
    expect(recorder.selectorSweeps()).toEqual(results);
    expect(recorder.pageCalls()).toEqual([]);
  });

  it("covers the in-call selectors and none of the pre-join or sign-in ones", () => {
    expect(new Set(IN_CALL_SELECTOR_KEYS).size).toBe(IN_CALL_SELECTOR_KEYS.length);
    for (const key of [
      "leaveCallButton",
      "activeSpeakerName",
      "participantTile",
      "endedText",
      "inMeetingMarker",
    ]) {
      expect(IN_CALL_SELECTOR_KEYS).toContain(key);
    }
    for (const key of IN_CALL_SELECTOR_KEYS) {
      expect(Object.keys(S)).toContain(key);
      expect(key.startsWith("signIn") || key === "signedInMarker").toBe(false);
    }
    for (const key of ["guestNameInput", "askToJoinButton", "joinNowButton", "switchHereButton"]) {
      expect(IN_CALL_SELECTOR_KEYS).not.toContain(key);
    }
  });
});

describe("ProbeRecorder samples", () => {
  it("keeps samples in arrival order with their receipt time", async () => {
    const recorder = new ProbeRecorder();
    await advance(100);
    recorder.acceptSample(sample(1));
    await advance(1000);
    recorder.acceptSample(sample(2));

    expect(recorder.samples().map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(recorder.sampleReceipts()).toEqual([
      { tMs: 100, sequence: 1 },
      { tMs: 1100, sequence: 2 },
    ]);
    expect(recorder.latestSample()?.sequence).toBe(2);
    expect(recorder.sampleCount()).toBe(2);
  });

  it("uses the injected clock", () => {
    let nowMs = 5000;
    const recorder = new ProbeRecorder({ now: () => nowMs });
    nowMs = 5250;

    expect(recorder.elapsedMs()).toBe(250);
  });

  it("resolves a wait for a later sequence when that sample arrives", async () => {
    const recorder = new ProbeRecorder();
    recorder.acceptSample(sample(4));

    const waiting = recorder.waitForSampleAfter(4, 5000);
    recorder.acceptSample(sample(4));
    await advance(10);
    recorder.acceptSample(sample(5));

    expect((await waiting)?.sequence).toBe(5);
  });

  it("resolves at once when a later sequence is already held", async () => {
    const recorder = new ProbeRecorder();
    recorder.acceptSample(sample(1));
    recorder.acceptSample(sample(2));
    recorder.acceptSample(sample(3));

    expect((await recorder.waitForSampleAfter(1, 0))?.sequence).toBe(2);
  });

  it("resolves null when no sample arrives in time", async () => {
    const recorder = new ProbeRecorder();
    const settled = vi.fn();

    const waiting = recorder.waitForSampleAfter(0, 2000).then((value) => {
      settled(value);
      return value;
    });
    await advance(1999);
    expect(settled).not.toHaveBeenCalled();
    await advance(1);

    expect(await waiting).toBeNull();
    // A sample after the timeout must not reach the waiter that already gave up.
    recorder.acceptSample(sample(1));
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("waits for the next arrival whatever its number", async () => {
    const recorder = new ProbeRecorder();
    recorder.acceptSample(sample(40));

    const first = recorder.waitForNextSample(1000);
    const second = recorder.waitForNextSample(1000);
    recorder.acceptSample(sample(1));

    expect((await first)?.sequence).toBe(1);
    expect((await second)?.sequence).toBe(1);
    const third = recorder.waitForNextSample(0);
    await advance(0);
    expect(await third).toBeNull();
  });
});

describe("after-leave observation on close", () => {
  it("observes on the inner page first, records it, then closes", async () => {
    const { inner, recorder, page } = setupPage({ maxMs: 3000 });
    inner.setUrl(FAKE_URL);
    inner.setVisible(S.leaveCallButton);
    inner.setVisible(S.dialogGotIt);
    await page.click(S.leaveCallButton);
    const callsBeforeClose = recorder.pageCalls().length;

    const closing = page.close();
    await advance(400);
    recorder.acceptSample(sample(7));
    inner.setVisible(S.endedText);
    inner.setVisible(S.leaveCallButton, false);
    await advance(400);
    expect(inner.closed).toBe(false);
    recorder.acceptSample(sample(8));
    recorder.acceptSample(sample(9));
    await advance(100);
    await closing;

    expect(inner.closed).toBe(true);
    expect(inner.closeCalls).toBe(1);
    const observation = recorder.afterLeave();
    expect(observation).toMatchObject({
      endedTextVisible: true,
      leaveCallButtonVisible: false,
      inMeetingMarkerVisible: false,
      dialogKeysVisible: ["dialogGotIt"],
      urlKind: "meeting",
      msFromClickToEndedText: 500,
    });
    expect(observation?.samples.map((entry) => entry.sequence)).toEqual([7, 8]);
    expect(observation?.observedMs).toBeLessThan(3000);
    // The observation reads are not adapter calls: only the close itself is added, timed after the observation.
    const added = recorder.pageCalls().slice(callsBeforeClose);
    expect(added.map(shape)).toEqual([
      { method: "close", selectorKey: null, result: { kind: "void" }, errorName: null },
    ]);
    expect(added[0]?.tMs).toBe(observation?.observedMs);
  });

  it("gives up after the limit when the ended text never shows", async () => {
    const { inner, recorder, page } = setupPage({ maxMs: AFTER_LEAVE_OBSERVATION_MS });
    inner.setVisible(S.inMeetingMarker);
    inner.setVisible(S.leaveCallButton);

    const closing = page.close();
    await advance(AFTER_LEAVE_OBSERVATION_MS - 1);
    expect(inner.closed).toBe(false);
    await advance(1);
    await closing;

    expect(inner.closed).toBe(true);
    expect(recorder.afterLeave()).toEqual({
      observedMs: AFTER_LEAVE_OBSERVATION_MS,
      endedTextVisible: false,
      leaveCallButtonVisible: true,
      inMeetingMarkerVisible: true,
      dialogKeysVisible: [],
      urlKind: "blank",
      msFromClickToEndedText: null,
      samples: [],
    });
  });

  it("does not wait on a page that is already gone", async () => {
    const { inner, recorder, page } = setupPage({ maxMs: 3000 });
    inner.setUrl("https://example.invalid/somewhere");
    inner.triggerClosed();

    await page.close();

    expect(recorder.afterLeave()).toMatchObject({
      observedMs: 0,
      endedTextVisible: false,
      leaveCallButtonVisible: false,
      urlKind: "other",
      samples: [],
    });
    expect(inner.closeCalls).toBe(1);
  });

  it("stops observing when the page goes away part-way", async () => {
    const { inner, recorder, page } = setupPage({ maxMs: 3000 });

    const closing = page.close();
    await advance(250);
    inner.triggerClosed();
    await advance(100);
    await closing;

    expect(recorder.afterLeave()?.observedMs).toBeLessThan(500);
    expect(inner.closeCalls).toBe(1);
  });

  it("still closes when the observation throws", async () => {
    const inner = new FakeMeetingPage();
    const recorder = new ProbeRecorder();
    const page = new RecordingMeetingPage({
      inner,
      recorder,
      afterLeave: {
        sleep: () => Promise.reject(new RangeError("fake observation failure")),
      },
    });

    await page.close();

    expect(inner.closed).toBe(true);
    expect(recorder.afterLeave()).toBeNull();
    expect(recorder.afterLeaveErrorName()).toBe("RangeError");
    expect(recorder.pageCalls().map(shape)).toEqual([
      { method: "close", selectorKey: null, result: { kind: "void" }, errorName: null },
    ]);
  });

  it("cannot hang on a clock that stands still", async () => {
    const inner = new FakeMeetingPage();
    const recorder = new ProbeRecorder({ now: () => 1000 });
    const sleep = vi.fn(() => Promise.resolve());
    const page = new RecordingMeetingPage({
      inner,
      recorder,
      afterLeave: { maxMs: 300, pollMs: 100, sleep },
    });

    await page.close();

    expect(inner.closed).toBe(true);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("observes once: a second close only closes", async () => {
    const { inner, recorder, page } = setupPage({ maxMs: 200 });
    const closing = page.close();
    await advance(200);
    await closing;
    const first = recorder.afterLeave();

    await page.close();

    expect(recorder.afterLeave()).toBe(first);
    expect(inner.closeCalls).toBe(2);
  });

  it("records and rethrows a failing close", async () => {
    const { inner, recorder, page } = setupPage();
    const error = new FakeTimeoutError();
    inner.setError("close", error);

    await expect(page.close()).rejects.toBe(error);

    expect(recorder.pageCalls().map(shape)).toEqual([
      { method: "close", selectorKey: null, result: null, errorName: "TimeoutError" },
    ]);
  });
});

describe("ProbeBrowserLauncher", () => {
  it("installs the probe script and binding on the inner page before handing it out", async () => {
    const { inner, recorder, fakeLauncher, launcher } = setupLauncher();

    const page = await launcher.open(BROWSER_OPTIONS);

    expect(page).toBeInstanceOf(RecordingMeetingPage);
    expect(page.inner).toBe(inner);
    expect(launcher.currentPage()).toBe(page);
    expect(fakeLauncher.openCalls).toEqual([BROWSER_OPTIONS]);
    expect(inner.actions).toEqual([
      { type: "addInitScript", source: FAKE_INIT_SCRIPT },
      { type: "exposeBinding", name: FAKE_BINDING },
    ]);
    // The install is the probe's, not the adapter's.
    expect(recorder.pageCalls()).toEqual([]);
  });

  it("decodes binding payloads into samples and counts the refused ones", async () => {
    const { inner, recorder, launcher } = setupLauncher();
    await launcher.open(BROWSER_OPTIONS);

    inner.triggerBinding(FAKE_BINDING, 1);
    inner.triggerBinding(FAKE_BINDING, "not a sample");
    inner.triggerBinding(FAKE_BINDING, 2);

    expect(recorder.samples().map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(recorder.snapshot().droppedSamplePayloads).toBe(1);
  });

  it("closes the page and rethrows when the install fails", async () => {
    const { inner, launcher } = setupLauncher();
    const error = new FakeTimeoutError();
    inner.setError("exposeBinding", error);

    await expect(launcher.open(BROWSER_OPTIONS)).rejects.toBe(error);

    expect(inner.closed).toBe(true);
    expect(launcher.currentPage()).toBeNull();
  });

  it("passes an open failure through", async () => {
    const { fakeLauncher, launcher } = setupLauncher();
    const error = new Error("fake launch failure");
    fakeLauncher.setOpenError(error);

    await expect(launcher.open(BROWSER_OPTIONS)).rejects.toBe(error);
  });
});

describe("a full GoogleMeetAdapter join and leave through the recording launcher", () => {
  function prepareGuestJoin(inner: FakeMeetingPage): void {
    const keys: MeetSelectorKey[] = [
      "joinScreenOrVerdict",
      "askToJoinButton",
      "guestNameInput",
      "turnOffMicrophone",
      "turnOffCamera",
      "microphoneSettled",
      "cameraSettled",
    ];
    for (const key of keys) inner.setVisible(S[key]);
    inner.onAction((action) => {
      if (action.type !== "click") return;
      if (action.selector === S.turnOffMicrophone) inner.setVisible(S.turnOffMicrophone, false);
      if (action.selector === S.turnOffCamera) inner.setVisible(S.turnOffCamera, false);
      if (action.selector === S.askToJoinButton) {
        for (const key of keys) inner.setVisible(S[key], false);
        inner.setVisible(S.inMeetingMarker);
        inner.setVisible(S.leaveCallButton);
      }
      if (action.selector === S.leaveCallButton) {
        inner.setVisible(S.inMeetingMarker, false);
        inner.setVisible(S.leaveCallButton, false);
        inner.setVisible(S.endedText);
      }
    });
  }

  it("records the join, the speaker reads and the leave steps", async () => {
    const { inner, recorder, launcher } = setupLauncher();
    prepareGuestJoin(inner);
    inner.setTexts(S.activeSpeakerName, [FAKE_TEXT]);
    const events: PlatformEvent[] = [];
    const handlers: PlatformHandlers = { onEvent: (event) => events.push(event), onAudioFrame: () => {} };
    const adapter = new GoogleMeetAdapter({
      browser: launcher,
      google: GUEST,
      chrome: CHROME,
      logger: createSilentLogger(),
    });

    await adapter.join({ meetingUrl: FAKE_URL, displayName: FAKE_NAME }, handlers);
    await advance(DEFAULT_POLL_INTERVAL_MS);
    expect(events.map((event) => event.type)).toEqual(["admitted", "speaker"]);

    // The probe's own install comes first and the adapter's script and bindings are all still there.
    expect(inner.actions.slice(0, 5)).toEqual([
      { type: "addInitScript", source: FAKE_INIT_SCRIPT },
      { type: "exposeBinding", name: FAKE_BINDING },
      { type: "addInitScript", source: inner.initScripts[1] },
      { type: "exposeBinding", name: AUDIO_FRAME_BINDING },
      { type: "exposeBinding", name: SOURCE_ACTIVITY_BINDING },
    ]);
    expect(inner.actions[5]).toEqual({ type: "goto", url: FAKE_URL });
    expect(inner.hasBinding(FAKE_BINDING)).toBe(true);

    const joinCalls = recorder.pageCalls();
    expect(joinCalls.slice(0, 5).map((call) => call.method)).toEqual([
      "onClosed",
      "addInitScript",
      "exposeBinding",
      "exposeBinding",
      "goto",
    ]);
    expect(joinCalls.map(shape)).toContainEqual({
      method: "fill",
      selectorKey: "guestNameInput",
      result: { kind: "void" },
      errorName: null,
    });
    expect(joinCalls.map(shape)).toContainEqual({
      method: "readTexts",
      selectorKey: "activeSpeakerName",
      result: { kind: "count", value: 1 },
      errorName: null,
    });
    // Every selector the adapter used is one of its own, so nothing was recorded without a key.
    const selectorMethods = ["isVisible", "waitForVisible", "click", "fill", "readText", "readTexts"];
    expect(
      joinCalls.filter((call) => selectorMethods.includes(call.method) && call.selectorKey === null)
    ).toEqual([]);

    const callsBeforeLeave = joinCalls.length;
    const leaving = adapter.leave();
    await advance(200);
    recorder.acceptSample(sample(1));
    recorder.acceptSample(sample(2));
    await advance(AFTER_LEAVE_OBSERVATION_MS);
    await leaving;

    expect(recorder.pageCalls().slice(callsBeforeLeave).map(shape)).toEqual([
      {
        method: "isVisible",
        selectorKey: "leaveCallButton",
        result: { kind: "boolean", value: true },
        errorName: null,
      },
      { method: "click", selectorKey: "leaveCallButton", result: { kind: "void" }, errorName: null },
      { method: "close", selectorKey: null, result: { kind: "void" }, errorName: null },
    ]);
    expect(inner.actions.slice(-2)).toEqual([
      { type: "click", selector: S.leaveCallButton },
      { type: "close" },
    ]);
    expect(recorder.afterLeave()).toMatchObject({
      endedTextVisible: true,
      leaveCallButtonVisible: false,
      inMeetingMarkerVisible: false,
      urlKind: "meeting",
      msFromClickToEndedText: 0,
    });
    expect(recorder.afterLeave()?.samples.map((entry) => entry.sequence)).toEqual([1, 2]);

    const json = JSON.stringify(recorder.snapshot());
    for (const secret of [FAKE_URL, FAKE_NAME, FAKE_TEXT, S.leaveCallButton.slice(0, 20)]) {
      expect(json).not.toContain(secret);
    }
  });
});
