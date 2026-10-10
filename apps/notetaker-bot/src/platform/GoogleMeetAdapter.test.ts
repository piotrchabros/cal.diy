// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pcm16Frame } from "../audio/AudioFrame";
import type { RunnerConfig } from "../config";
import type { Logger } from "../logger";
import { createLogger, createSilentLogger } from "../logger";
import type { MeetingPageState } from "./browser/BrowserPlatformAdapter";
import { DEFAULT_POLL_INTERVAL_MS } from "./browser/BrowserPlatformAdapter";
import type { FakeElementRow, FakePageAction } from "./browser/FakeMeetingPage";
import { FakeMeetingBrowserLauncher, FakeMeetingPage } from "./browser/FakeMeetingPage";
import {
  GOOGLE_MEET_CHAT_INPUT_TIMEOUT_MS,
  GOOGLE_MEET_CHAT_SEND_READY_TIMEOUT_MS,
  GOOGLE_MEET_CHAT_SENT_POLL_MS,
  GOOGLE_MEET_CHAT_SENT_TIMEOUT_MS,
  GOOGLE_MEET_DEVICE_SETTLE_TIMEOUT_MS,
  GOOGLE_MEET_JOIN_SCREEN_TIMEOUT_MS,
  GOOGLE_MEET_SELECTORS,
  GOOGLE_MEET_SPEAKING_INDICATORS,
  GOOGLE_MEET_TILE_ATTRIBUTES,
  GOOGLE_SIGN_IN_STEP_TIMEOUT_MS,
  GOOGLE_SIGN_IN_URL,
  GoogleMeetAdapter,
  GoogleMeetPageDriver,
} from "./GoogleMeetAdapter";
import type { PlatformEvent, PlatformHandlers } from "./PlatformAdapter";
import { PlatformLinkUnusableError } from "./PlatformAdapter";

type SelectorKey = keyof typeof GOOGLE_MEET_SELECTORS;
type GoogleConfig = RunnerConfig["google"];
type FillAction = Extract<FakePageAction, { type: "fill" | "fillInAnyFrame" }>;

const S = GOOGLE_MEET_SELECTORS;
const POLL = DEFAULT_POLL_INTERVAL_MS;

const INPUT = { meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Fake Notetaker Name" };
const NOTICE = "Fake chat notice text";
const FAKE_EMAIL = "bot@fake.invalid";
const FAKE_PASSWORD = "fake-password-not-real";
const FAKE_STORAGE_STATE = { cookies: [], origins: [] };
const FAKE_SPEAKER = "Ada Lovelace";
const FAKE_ID = "spaces/fake/devices/fake-participant-id";

const GUEST: GoogleConfig = { joinMode: "guest", storageState: null, email: null, password: null };
const ACCOUNT_WITH_STATE: GoogleConfig = {
  joinMode: "account",
  storageState: FAKE_STORAGE_STATE,
  email: null,
  password: null,
};
const ACCOUNT_WITH_PASSWORD: GoogleConfig = {
  joinMode: "account",
  storageState: null,
  email: FAKE_EMAIL,
  password: FAKE_PASSWORD,
};
const CHROME: RunnerConfig["chrome"] = { channel: "fake-channel", headless: true };

// Written out here instead of derived from the implementation, so the proof of what the bot may touch does not
// depend on the code it constrains.
const ALL_KEYS = [
  "dialogContinueWithoutDevices",
  "dialogGotIt",
  "dialogDismiss",
  "turnOffMicrophone",
  "turnOffCamera",
  "microphoneSettled",
  "cameraSettled",
  "guestNameInput",
  "askToJoinButton",
  "joinNowButton",
  "switchHereButton",
  "joinScreenOrVerdict",
  "inMeetingMarker",
  "waitingText",
  "deniedText",
  "removedText",
  "endedText",
  "linkInvalidText",
  "participantCountBadge",
  "participantTile",
  "activeSpeakerName",
  "chatButton",
  "chatPanelOpen",
  "chatInput",
  "chatSendButton",
  "leaveCallButton",
  "signInEmailInput",
  "signInEmailNext",
  "signInPasswordInput",
  "signInPasswordNext",
  "signedInMarker",
];
const CLICKABLE_KEYS: SelectorKey[] = [
  "dialogContinueWithoutDevices",
  "dialogGotIt",
  "dialogDismiss",
  "turnOffMicrophone",
  "turnOffCamera",
  "askToJoinButton",
  "joinNowButton",
  "switchHereButton",
  "chatButton",
  "chatSendButton",
  "leaveCallButton",
  "signInEmailNext",
  "signInPasswordNext",
];
const FILLABLE_KEYS: SelectorKey[] = [
  "guestNameInput",
  "chatInput",
  "signInEmailInput",
  "signInPasswordInput",
];
const FORBIDDEN_CONTROL_WORDS = [
  "turn on",
  "unmute",
  "present",
  "share",
  "raise",
  "hand",
  "reaction",
  "caption",
  "subtitle",
  "record",
  "setting",
  "more options",
  "effects",
  "here too",
  "companion",
];

const PRE_JOIN_KEYS: SelectorKey[] = [
  "joinScreenOrVerdict",
  "askToJoinButton",
  "joinNowButton",
  "switchHereButton",
  "guestNameInput",
  "turnOffMicrophone",
  "turnOffCamera",
];
const STATE_KEYS: SelectorKey[] = [
  "inMeetingMarker",
  "waitingText",
  "deniedText",
  "removedText",
  "endedText",
  "linkInvalidText",
];
const STATE_MARKERS: Partial<Record<MeetingPageState, SelectorKey>> = {
  IN_MEETING: "inMeetingMarker",
  WAITING: "waitingText",
  DENIED: "deniedText",
  REMOVED: "removedText",
  ENDED: "endedText",
  LINK_INVALID: "linkInvalidText",
};

const SINGLE_MARKERS: [SelectorKey, MeetingPageState][] = [
  ["inMeetingMarker", "IN_MEETING"],
  ["waitingText", "WAITING"],
  ["deniedText", "DENIED"],
  ["removedText", "REMOVED"],
  ["endedText", "ENDED"],
  ["linkInvalidText", "LINK_INVALID"],
  ["askToJoinButton", "PRE_JOIN"],
  ["joinNowButton", "PRE_JOIN"],
  ["switchHereButton", "PRE_JOIN"],
  ["guestNameInput", "PRE_JOIN"],
];
const PRECEDENCE: [MeetingPageState, SelectorKey[]][] = [
  [
    "IN_MEETING",
    ["inMeetingMarker", "linkInvalidText", "removedText", "deniedText", "endedText", "waitingText"],
  ],
  [
    "LINK_INVALID",
    ["linkInvalidText", "removedText", "deniedText", "endedText", "waitingText", "askToJoinButton"],
  ],
  ["REMOVED", ["removedText", "deniedText", "endedText", "waitingText", "askToJoinButton"]],
  ["DENIED", ["deniedText", "endedText", "waitingText", "askToJoinButton"]],
  ["ENDED", ["endedText", "waitingText", "askToJoinButton"]],
  ["WAITING", ["waitingText", "askToJoinButton", "leaveCallButton"]],
];

let pages: FakeMeetingPage[] = [];

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

// Rejections are swallowed into the tracker so a deliberately failing call never surfaces as an unhandled rejection.
function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    }
  );
  return state;
}

function createHandlers(): { handlers: PlatformHandlers; events: PlatformEvent[]; frames: Pcm16Frame[] } {
  const events: PlatformEvent[] = [];
  const frames: Pcm16Frame[] = [];
  const handlers: PlatformHandlers = {
    onEvent: (event) => {
      events.push(event);
    },
    onAudioFrame: (frame) => {
      frames.push(frame);
    },
  };
  return { handlers, events, frames };
}

function createPage(): FakeMeetingPage {
  const page = new FakeMeetingPage();
  pages.push(page);
  return page;
}

function createCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  return { logger, lines };
}

function createDriver(google: GoogleConfig = GUEST): GoogleMeetPageDriver {
  return new GoogleMeetPageDriver({ google, logger: createSilentLogger() });
}

function show(page: FakeMeetingPage, keys: SelectorKey[], visible = true): void {
  for (const key of keys) page.setVisible(S[key], visible);
}

function onClick(page: FakeMeetingPage, key: SelectorKey, effect: () => void): void {
  page.onAction((action) => {
    if (action.type === "click" && action.selector === S[key]) effect();
  });
}

function showPreJoin(page: FakeMeetingPage, options: { guest: boolean }): void {
  show(page, [
    "joinScreenOrVerdict",
    "askToJoinButton",
    "turnOffMicrophone",
    "turnOffCamera",
    "microphoneSettled",
    "cameraSettled",
  ]);
  if (options.guest) show(page, ["guestNameInput"]);
}

function showState(page: FakeMeetingPage, state: MeetingPageState): void {
  show(page, STATE_KEYS, false);
  const key = STATE_MARKERS[state];
  if (key) show(page, [key]);
}

function wireDeviceToggles(page: FakeMeetingPage): void {
  onClick(page, "turnOffMicrophone", () => show(page, ["turnOffMicrophone"], false));
  onClick(page, "turnOffCamera", () => show(page, ["turnOffCamera"], false));
}

function wireJoin(page: FakeMeetingPage, next: MeetingPageState): void {
  const enter = (): void => {
    show(page, PRE_JOIN_KEYS, false);
    showState(page, next);
  };
  onClick(page, "askToJoinButton", enter);
  onClick(page, "joinNowButton", enter);
  onClick(page, "switchHereButton", enter);
}

function wireDialog(page: FakeMeetingPage, key: SelectorKey): void {
  onClick(page, key, () => show(page, [key], false));
}

// Sending empties the composer, which is the only sign of success the driver can read.
function clearComposerOnSend(page: FakeMeetingPage): void {
  page.onAction((action) => {
    if (action.type === "clickInAnyFrame" && action.selector === S.chatSendButton) {
      page.setValue(S.chatInput, "");
    }
  });
}

function wireChat(page: FakeMeetingPage, variant: "classic" | "embedded" = "classic"): void {
  onClick(page, "chatButton", () => {
    show(page, ["chatPanelOpen"]);
    if (variant === "classic") {
      show(page, ["chatInput", "chatSendButton"]);
      return;
    }
    page.setVisibleInChildFrame(S.chatInput);
    page.setVisibleInChildFrame(S.chatSendButton);
  });
  clearComposerOnSend(page);
}

function wireSignIn(page: FakeMeetingPage): void {
  show(page, ["signInEmailInput"]);
  onClick(page, "signInEmailNext", () => show(page, ["signInPasswordInput"]));
  onClick(page, "signInPasswordNext", () => show(page, ["signedInMarker"]));
}

function prepareJoin(page: FakeMeetingPage, options: { guest: boolean; next: MeetingPageState }): void {
  showPreJoin(page, { guest: options.guest });
  wireDeviceToggles(page);
  wireJoin(page, options.next);
}

const clicks = (page: FakeMeetingPage): string[] =>
  page.actions.flatMap((action) =>
    action.type === "click" || action.type === "clickInAnyFrame" ? [action.selector] : []
  );
const fillActions = (page: FakeMeetingPage): FillAction[] =>
  page.actions.filter(
    (action): action is FillAction => action.type === "fill" || action.type === "fillInAnyFrame"
  );
const fills = (page: FakeMeetingPage): string[] => fillActions(page).map((action) => action.selector);
const gotos = (page: FakeMeetingPage): string[] =>
  page.actions.flatMap((action) => (action.type === "goto" ? [action.url] : []));
const pressedKeys = (page: FakeMeetingPage): string[] =>
  page.actions.flatMap((action) => (action.type === "pressKey" ? [action.key] : []));
const eventTypes = (events: PlatformEvent[]): string[] => events.map((event) => event.type);
const speakerEvents = (events: PlatformEvent[]): PlatformEvent[] =>
  events.filter((event) => event.type === "speaker");
const countEvents = (events: PlatformEvent[]): number[] =>
  events.flatMap((event) => (event.type === "participant_count" ? [event.count] : []));
const speakerEvent = (participantId: string, name: string, speaking: boolean): PlatformEvent => ({
  type: "speaker",
  participantId,
  name,
  speaking,
});
const participantsEvents = (events: PlatformEvent[]): PlatformEvent[] =>
  events.filter((event) => event.type === "participants");
const SUSTAINED = GOOGLE_MEET_SPEAKING_INDICATORS.sustained;
const INSTANT = GOOGLE_MEET_SPEAKING_INDICATORS.instantaneous;
const tile = (id: string | null, name: string | null, classes: string | null = "tile"): FakeElementRow => ({
  attributes: { "data-participant-id": id, class: classes },
  text: name,
});

// A comma inside quotes or brackets belongs to one alternative, as in :text-matches("...", "i").
function splitAlternatives(selector: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (const char of selector) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "(" || char === "[")) depth += 1;
    if (!quoted && (char === ")" || char === "]")) depth -= 1;
    if (char === "," && !quoted && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function setupAdapter(google: GoogleConfig = GUEST, options: { logger?: Logger } = {}) {
  const page = createPage();
  const launcher = new FakeMeetingBrowserLauncher({ pages: [page] });
  const { handlers, events } = createHandlers();
  const adapter = new GoogleMeetAdapter({
    browser: launcher,
    google,
    chrome: CHROME,
    logger: options.logger ?? createSilentLogger(),
  });
  return { adapter, page, launcher, handlers, events };
}

type Ctx = ReturnType<typeof setupAdapter>;

async function joinedAs(
  google: GoogleConfig,
  next: MeetingPageState,
  options: { logger?: Logger } = {}
): Promise<Ctx> {
  const ctx = setupAdapter(google, options);
  prepareJoin(ctx.page, { guest: google.joinMode === "guest", next });
  await ctx.adapter.join(INPUT, ctx.handlers);
  return ctx;
}

async function admittedGuest(): Promise<Ctx> {
  const ctx = await joinedAs(GUEST, "IN_MEETING");
  await advance(POLL);
  return ctx;
}

async function lostGuest(): Promise<Ctx> {
  const ctx = await joinedAs(GUEST, "WAITING");
  await advance(POLL);
  showState(ctx.page, "IN_MEETING");
  await advance(POLL);
  ctx.page.triggerClosed();
  return ctx;
}

function enqueueSecondPage(ctx: Ctx, next: MeetingPageState): FakeMeetingPage {
  const second = createPage();
  prepareJoin(second, { guest: true, next });
  ctx.launcher.enqueuePage(second);
  return second;
}

beforeEach(() => {
  vi.useFakeTimers();
  pages = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Runs for every test in the file: whatever a scenario does, the bot may only touch the listed controls.
afterEach(() => {
  const clickable = CLICKABLE_KEYS.map((key) => S[key]);
  const fillable = FILLABLE_KEYS.map((key) => S[key]);
  for (const page of pages) {
    expect(clicks(page).filter((selector) => !clickable.includes(selector))).toEqual([]);
    expect(fills(page).filter((selector) => !fillable.includes(selector))).toEqual([]);
    expect(pressedKeys(page).filter((key) => key !== "Enter")).toEqual([]);
  }
});

describe("selectors", () => {
  it("has every key the driver and the smoke doc rely on", () => {
    expect(Object.keys(S).sort()).toEqual([...ALL_KEYS].sort());
  });

  // The fake page treats a selector as an opaque key, so two keys sharing one string would blur every test below.
  it("gives every key its own selector", () => {
    const values = Object.values(S);

    expect(new Set(values).size).toBe(values.length);
  });

  it("contains no selector for a forbidden control", () => {
    for (const value of Object.values(S)) {
      const lowered = value.toLowerCase();
      expect(FORBIDDEN_CONTROL_WORDS.filter((word) => lowered.includes(word))).toEqual([]);
    }
  });

  it("counts the Switch here control as a settled join screen", () => {
    expect(splitAlternatives(S.joinScreenOrVerdict)).toContain(S.switchHereButton);
  });

  it("builds the active speaker selector from the sustained token and never from an aria-label", () => {
    expect(S.activeSpeakerName).toContain(`.${SUSTAINED}`);
    for (const value of Object.values(S)) {
      expect(value.toLowerCase()).not.toContain('aria-label*="speaking"');
    }
  });

  it("limits every alternative to visible elements", () => {
    for (const value of Object.values(S)) {
      const alternatives = splitAlternatives(value);
      expect(alternatives.filter((alternative) => !alternative.endsWith(":visible"))).toEqual([]);
    }
  });
});

describe("adapter wiring", () => {
  it("is a Google Meet adapter", () => {
    const { adapter } = setupAdapter();

    expect(adapter.platform).toBe("GOOGLE_MEET");
  });

  it("opens the browser with the chrome options and no storage state for a guest", async () => {
    const { launcher } = await joinedAs(GUEST, "WAITING");

    expect(launcher.openCalls).toEqual([{ channel: "fake-channel", headless: true, storageState: null }]);
  });

  it("drops a storage state in guest mode", async () => {
    const google: GoogleConfig = {
      joinMode: "guest",
      storageState: FAKE_STORAGE_STATE,
      email: null,
      password: null,
    };

    const { launcher } = await joinedAs(google, "WAITING");

    expect(launcher.openCalls[0]?.storageState).toBeNull();
  });

  it("hands the storage state object to the browser in account mode", async () => {
    const { launcher } = await joinedAs(ACCOUNT_WITH_STATE, "WAITING");

    expect(launcher.openCalls[0]?.storageState).toBe(FAKE_STORAGE_STATE);
  });
});

describe("guest join", () => {
  it("navigates to the meeting URL after the capture script and bindings", async () => {
    const { page } = await joinedAs(GUEST, "WAITING");

    expect(page.actions.map((action) => action.type)).toEqual([
      "addInitScript",
      "exposeBinding",
      "exposeBinding",
      "goto",
      "click",
      "click",
      "fill",
      "click",
    ]);
    expect(gotos(page)).toEqual([INPUT.meetingUrl]);
    expect(gotos(page)).not.toContain(GOOGLE_SIGN_IN_URL);
  });

  it("turns microphone and camera off, types the name, then asks to join", async () => {
    const { page } = await joinedAs(GUEST, "WAITING");

    expect(clicks(page)).toEqual([S.turnOffMicrophone, S.turnOffCamera, S.askToJoinButton]);
    expect(fillActions(page)).toEqual([
      { type: "fill", selector: S.guestNameInput, value: INPUT.displayName },
    ]);
    const indexOf = (type: "click" | "fill", selector: string): number =>
      page.actions.findIndex((action) => action.type === type && action.selector === selector);
    const fillIndex = indexOf("fill", S.guestNameInput);
    expect(fillIndex).toBeGreaterThan(indexOf("click", S.turnOffMicrophone));
    expect(fillIndex).toBeGreaterThan(indexOf("click", S.turnOffCamera));
    expect(fillIndex).toBeLessThan(indexOf("click", S.askToJoinButton));
  });

  it("dismisses a dialog before touching the device toggles", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["dialogContinueWithoutDevices"]);
    wireDialog(ctx.page, "dialogContinueWithoutDevices");

    await ctx.adapter.join(INPUT, ctx.handlers);

    expect(clicks(ctx.page)).toEqual([
      S.dialogContinueWithoutDevices,
      S.turnOffMicrophone,
      S.turnOffCamera,
      S.askToJoinButton,
    ]);
  });

  it("dismisses a dialog that appears after the name was typed", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    ctx.page.onAction((action) => {
      if (action.type === "fill" && action.selector === S.guestNameInput) show(ctx.page, ["dialogGotIt"]);
    });
    wireDialog(ctx.page, "dialogGotIt");

    await ctx.adapter.join(INPUT, ctx.handlers);

    expect(clicks(ctx.page).slice(-2)).toEqual([S.dialogGotIt, S.askToJoinButton]);
  });

  it("clicks no device control when both are already off", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["turnOffMicrophone", "turnOffCamera"], false);

    await ctx.adapter.join(INPUT, ctx.handlers);

    expect(clicks(ctx.page)).toEqual([S.askToJoinButton]);
  });

  it("uses Join now when Ask to join is absent", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["askToJoinButton"], false);
    show(ctx.page, ["joinNowButton"]);

    await ctx.adapter.join(INPUT, ctx.handlers);

    expect(clicks(ctx.page).at(-1)).toBe(S.joinNowButton);
    expect(clicks(ctx.page)).not.toContain(S.askToJoinButton);
  });

  it("waits out Meet's transient turn-off controls and joins once they settle", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["microphoneSettled", "cameraSettled"], false);

    const joining = track(ctx.adapter.join(INPUT, ctx.handlers));
    await advance(1000);
    expect(joining.settled).toBe(false);
    expect(clicks(ctx.page)).toEqual([]);
    show(ctx.page, ["turnOffMicrophone", "turnOffCamera"], false);
    show(ctx.page, ["microphoneSettled", "cameraSettled"]);
    await advance(1);

    expect(joining.settled).toBe(true);
    expect(joining.error).toBeUndefined();
    expect(clicks(ctx.page)).toEqual([S.askToJoinButton]);
  });

  it("adds no delay when the device controls have already settled", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["turnOffMicrophone", "turnOffCamera"], false);
    const waitForVisible = vi.spyOn(ctx.page, "waitForVisible");
    const startedAt = Date.now();

    await ctx.adapter.join(INPUT, ctx.handlers);

    expect(Date.now()).toBe(startedAt);
    expect(waitForVisible).toHaveBeenCalledWith(S.microphoneSettled, GOOGLE_MEET_DEVICE_SETTLE_TIMEOUT_MS);
    expect(waitForVisible).toHaveBeenCalledWith(S.cameraSettled, GOOGLE_MEET_DEVICE_SETTLE_TIMEOUT_MS);
    expect(clicks(ctx.page)).toEqual([S.askToJoinButton]);
  });

  it("after a settle timeout still turns live devices off and joins", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["microphoneSettled", "cameraSettled"], false);

    const joining = track(ctx.adapter.join(INPUT, ctx.handlers));
    await advance(GOOGLE_MEET_DEVICE_SETTLE_TIMEOUT_MS);
    await advance(GOOGLE_MEET_DEVICE_SETTLE_TIMEOUT_MS);

    expect(joining.settled).toBe(true);
    expect(joining.error).toBeUndefined();
    expect(clicks(ctx.page)).toEqual([S.turnOffMicrophone, S.turnOffCamera, S.askToJoinButton]);
  });

  it("emits waiting on the first poll", async () => {
    const { events } = await joinedAs(GUEST, "WAITING");
    expect(events).toEqual([]);

    await advance(POLL);

    expect(events).toEqual([{ type: "waiting" }]);
  });

  it("logs no warning about the display name", async () => {
    const { logger, lines } = createCapturingLogger();

    await joinedAs(GUEST, "WAITING", { logger });
    await advance(POLL);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes('"level":"warn"'))).toEqual([]);
  });
});

describe("join refusals", () => {
  it("rejects and clicks nothing when no join screen shows in time", async () => {
    const ctx = setupAdapter();

    const joining = track(ctx.adapter.join(INPUT, ctx.handlers));
    await advance(GOOGLE_MEET_JOIN_SCREEN_TIMEOUT_MS - 1);
    expect(joining.settled).toBe(false);
    await advance(1);

    expect(joining.settled).toBe(true);
    expect(joining.error).toBeInstanceOf(Error);
    expect(joining.error).not.toBeInstanceOf(PlatformLinkUnusableError);
    expect(clicks(ctx.page)).toEqual([]);
    expect(fills(ctx.page)).toEqual([]);
    expect(ctx.page.closed).toBe(true);
  });

  it("rejects with PlatformLinkUnusableError for an invalid link and touches nothing", async () => {
    const ctx = setupAdapter();
    show(ctx.page, ["joinScreenOrVerdict", "linkInvalidText"]);

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toBeInstanceOf(PlatformLinkUnusableError);

    expect(clicks(ctx.page)).toEqual([]);
    expect(fills(ctx.page)).toEqual([]);
  });

  it("does not ask to join when the microphone stays on", async () => {
    const ctx = setupAdapter();
    showPreJoin(ctx.page, { guest: true });
    wireJoin(ctx.page, "WAITING");

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toThrow("microphone could not be turned off");

    expect(clicks(ctx.page)).not.toContain(S.askToJoinButton);
    expect(clicks(ctx.page)).not.toContain(S.joinNowButton);
  });

  it("still refuses to join when the controls never settle and the microphone stays on", async () => {
    const ctx = setupAdapter();
    showPreJoin(ctx.page, { guest: true });
    show(ctx.page, ["microphoneSettled", "cameraSettled"], false);
    wireJoin(ctx.page, "WAITING");

    const joining = track(ctx.adapter.join(INPUT, ctx.handlers));
    await advance(GOOGLE_MEET_DEVICE_SETTLE_TIMEOUT_MS - 1);
    expect(joining.settled).toBe(false);
    expect(clicks(ctx.page)).toEqual([]);
    await advance(1);

    expect(joining.settled).toBe(true);
    expect(joining.error).toBeInstanceOf(Error);
    const message = joining.error instanceof Error ? joining.error.message : "";
    expect(message).toContain("microphone could not be turned off");
    expect(clicks(ctx.page)).toEqual([S.turnOffMicrophone]);
  });

  it("does not ask to join when the camera stays on", async () => {
    const ctx = setupAdapter();
    showPreJoin(ctx.page, { guest: true });
    onClick(ctx.page, "turnOffMicrophone", () => show(ctx.page, ["turnOffMicrophone"], false));
    wireJoin(ctx.page, "WAITING");

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toThrow("camera could not be turned off");

    expect(clicks(ctx.page)).not.toContain(S.askToJoinButton);
    expect(clicks(ctx.page)).not.toContain(S.joinNowButton);
  });

  it("does not join as a guest without a name field", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: false, next: "WAITING" });

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toThrow("guest name field");

    expect(fills(ctx.page)).toEqual([]);
    expect(clicks(ctx.page)).not.toContain(S.askToJoinButton);
    expect(clicks(ctx.page)).not.toContain(S.joinNowButton);
  });

  it("does not join when no join control is shown", async () => {
    const ctx = setupAdapter();
    show(ctx.page, ["joinScreenOrVerdict", "guestNameInput", "microphoneSettled", "cameraSettled"]);

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toThrow("no control to ask to join");

    expect(clicks(ctx.page)).toEqual([]);
  });

  it("resolves and reports denied when the meeting refuses guests up front", async () => {
    const ctx = setupAdapter();
    show(ctx.page, ["joinScreenOrVerdict", "deniedText"]);

    await ctx.adapter.join(INPUT, ctx.handlers);
    await advance(POLL);

    expect(clicks(ctx.page)).toEqual([]);
    expect(fills(ctx.page)).toEqual([]);
    expect(ctx.events).toEqual([{ type: "denied" }]);
  });
});

describe("account join", () => {
  it("with a storage state: no sign-in, no name typed", async () => {
    const { page } = await joinedAs(ACCOUNT_WITH_STATE, "WAITING");

    expect(gotos(page)).toEqual([INPUT.meetingUrl]);
    expect(fills(page)).toEqual([]);
    expect(clicks(page)).toEqual([S.turnOffMicrophone, S.turnOffCamera, S.askToJoinButton]);
  });

  it("with email and password: signs in before opening the meeting", async () => {
    const ctx = setupAdapter(ACCOUNT_WITH_PASSWORD);
    wireSignIn(ctx.page);
    prepareJoin(ctx.page, { guest: false, next: "WAITING" });

    await ctx.adapter.join(INPUT, ctx.handlers);

    const driverActions = ctx.page.actions.filter(
      (action) => action.type !== "addInitScript" && action.type !== "exposeBinding"
    );
    expect(driverActions.slice(0, 6)).toEqual([
      { type: "goto", url: GOOGLE_SIGN_IN_URL },
      { type: "fill", selector: S.signInEmailInput, value: FAKE_EMAIL },
      { type: "click", selector: S.signInEmailNext },
      { type: "fill", selector: S.signInPasswordInput, value: FAKE_PASSWORD },
      { type: "click", selector: S.signInPasswordNext },
      { type: "goto", url: INPUT.meetingUrl },
    ]);
    expect(fills(ctx.page)).not.toContain(S.guestNameInput);
  });

  it("logs exactly one warning that the display name could not be applied, also after a reconnect", async () => {
    const { logger, lines } = createCapturingLogger();
    const ctx = await joinedAs(ACCOUNT_WITH_STATE, "IN_MEETING", { logger });
    await advance(POLL);
    expect(eventTypes(ctx.events)).toContain("admitted");

    ctx.page.triggerClosed();
    const second = createPage();
    prepareJoin(second, { guest: false, next: "IN_MEETING" });
    ctx.launcher.enqueuePage(second);
    expect(await ctx.adapter.reconnect()).toBe(true);

    const warnings = lines.filter(
      (line) => line.includes('"level":"warn"') && line.includes("display name cannot be applied")
    );
    expect(warnings.length).toBe(1);
    expect(lines.filter((line) => line.includes(INPUT.displayName))).toEqual([]);
  });

  it("joins by switching here when that is the only join control, and logs it", async () => {
    const { logger, lines } = createCapturingLogger();
    const ctx = setupAdapter(ACCOUNT_WITH_STATE, { logger });
    prepareJoin(ctx.page, { guest: false, next: "IN_MEETING" });
    show(ctx.page, ["askToJoinButton"], false);
    show(ctx.page, ["switchHereButton"]);

    await ctx.adapter.join(INPUT, ctx.handlers);
    await advance(POLL);

    expect(clicks(ctx.page)).toEqual([S.turnOffMicrophone, S.turnOffCamera, S.switchHereButton]);
    expect(eventTypes(ctx.events)).toContain("admitted");
    expect(lines.some((line) => line.includes('"control":"switch_here"'))).toBe(true);
  });

  it.each(["askToJoinButton", "joinNowButton"] as const)("prefers %s over Switch here", async (key) => {
    const ctx = setupAdapter(ACCOUNT_WITH_STATE);
    prepareJoin(ctx.page, { guest: false, next: "WAITING" });
    show(ctx.page, ["askToJoinButton"], false);
    show(ctx.page, [key, "switchHereButton"]);

    await ctx.adapter.join(INPUT, ctx.handlers);

    expect(clicks(ctx.page).at(-1)).toBe(S[key]);
    expect(clicks(ctx.page)).not.toContain(S.switchHereButton);
  });

  it("refuses to join when the page shows the guest name field", async () => {
    const ctx = setupAdapter(ACCOUNT_WITH_STATE);
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toThrow("guest join screen");

    expect(fills(ctx.page)).toEqual([]);
    expect(clicks(ctx.page)).not.toContain(S.askToJoinButton);
    expect(clicks(ctx.page)).not.toContain(S.joinNowButton);
  });

  it.each([
    "email",
    "password",
    "completion",
  ] as const)("fails when sign-in stalls at step %s", async (step) => {
    const page = createPage();
    if (step !== "email") show(page, ["signInEmailInput"]);
    if (step === "completion") onClick(page, "signInEmailNext", () => show(page, ["signInPasswordInput"]));
    const driver = createDriver(ACCOUNT_WITH_PASSWORD);

    const signingIn = track(driver.signIn(page));
    await advance(GOOGLE_SIGN_IN_STEP_TIMEOUT_MS - 1);
    expect(signingIn.settled).toBe(false);
    await advance(1);

    expect(signingIn.settled).toBe(true);
    expect(signingIn.error).toBeInstanceOf(Error);
    const message = signingIn.error instanceof Error ? signingIn.error.message : "";
    expect(message).toContain(`stalled at step ${step}`);
    expect(message).not.toContain(FAKE_EMAIL);
    expect(message).not.toContain(FAKE_PASSWORD);
  });

  it("fails with the variable names when credentials are missing", async () => {
    const page = createPage();
    const driver = createDriver({ joinMode: "account", storageState: null, email: null, password: null });

    await expect(driver.signIn(page)).rejects.toThrow("NOTETAKER_GOOGLE_ACCOUNT_EMAIL");

    expect(page.actions).toEqual([]);
  });

  it("guest signIn touches nothing", async () => {
    const page = createPage();

    await createDriver(GUEST).signIn(page);

    expect(page.actions).toEqual([]);
  });

  it("signIn with a storage state touches nothing", async () => {
    const page = createPage();

    await createDriver(ACCOUNT_WITH_STATE).signIn(page);

    expect(page.actions).toEqual([]);
  });
});

describe("state mapping", () => {
  it.each(SINGLE_MARKERS)("%s alone is %s", async (key, state) => {
    const page = createPage();
    show(page, [key]);

    expect(await createDriver().readState(page)).toBe(state);
  });

  it("an empty page is UNKNOWN", async () => {
    expect(await createDriver().readState(createPage())).toBe("UNKNOWN");
  });

  // The waiting screen may show a leave control too, so it must not count as admission.
  it("the leave button alone is UNKNOWN", async () => {
    const page = createPage();
    show(page, ["leaveCallButton"]);

    expect(await createDriver().readState(page)).toBe("UNKNOWN");
  });

  it.each(PRECEDENCE)("%s wins over every marker ranked below it", async (state, keys) => {
    const page = createPage();
    show(page, keys);

    expect(await createDriver().readState(page)).toBe(state);
  });

  it("reading the state performs no page action", async () => {
    const page = createPage();
    show(page, ["inMeetingMarker"]);
    const driver = createDriver();

    await driver.readState(page);
    showState(page, "UNKNOWN");
    await driver.readState(page);

    expect(page.actions).toEqual([]);
  });

  it("maps a whole meeting to events", async () => {
    const { page, events } = await joinedAs(GUEST, "WAITING");
    await advance(POLL);

    showState(page, "IN_MEETING");
    page.setText(S.participantCountBadge, "3");
    await advance(POLL);
    showState(page, "REMOVED");
    await advance(POLL);

    expect(events).toEqual([
      { type: "waiting" },
      { type: "admitted" },
      { type: "participant_count", count: 3 },
      { type: "participants", participants: [] },
      { type: "removed" },
    ]);
  });

  it.each([
    ["ENDED", "meeting_ended"],
    ["DENIED", "denied"],
  ] as const)("maps %s before admission to %s", async (state, eventType) => {
    const { page, events } = await joinedAs(GUEST, "WAITING");
    await advance(POLL);

    showState(page, state);
    await advance(POLL);

    expect(events).toEqual([{ type: "waiting" }, { type: eventType }]);
  });
});

describe("participant count", () => {
  it.each([
    ["3", 3],
    [" 12 ", 12],
    ["People 4", 4],
  ] as const)("reads badge text %j as a count", async (text, count) => {
    const page = createPage();
    page.setText(S.participantCountBadge, text);

    expect(await createDriver().readParticipantCount(page)).toBe(count);
  });

  it.each([
    [null],
    ["0"],
    ["abc"],
  ] as const)("falls back to the number of tiles for badge %j", async (text) => {
    const page = createPage();
    page.setText(S.participantCountBadge, text);
    page.setTexts(S.participantTile, ["a", "b"]);

    expect(await createDriver().readParticipantCount(page)).toBe(2);
  });

  it("is null when neither is readable", async () => {
    expect(await createDriver().readParticipantCount(createPage())).toBeNull();
  });

  it("emits a count only when it changes", async () => {
    const { page, events } = await joinedAs(GUEST, "IN_MEETING");

    for (const text of ["2", "2", "3"]) {
      page.setText(S.participantCountBadge, text);
      await advance(POLL);
    }

    expect(countEvents(events)).toEqual([2, 3]);
  });
});

describe("participant tiles", () => {
  const readTiles = async (rows: FakeElementRow[], driver = createDriver()) => {
    const page = createPage();
    page.setElements(S.participantTile, rows);
    return { page, readings: await driver.readParticipants(page) };
  };

  it("reads every tile with its id, name and indicator flags", async () => {
    const { readings } = await readTiles([
      tile("p1", "Ada Lovelace", `x ${SUSTAINED} y`),
      tile("p2", "Bob", INSTANT),
      tile("p3", "You"),
    ]);

    expect(readings).toEqual([
      { participantId: "p1", name: "Ada Lovelace", speaking: true, speakingNow: false, isSelf: false },
      { participantId: "p2", name: "Bob", speaking: false, speakingNow: true, isSelf: false },
      { participantId: "p3", name: "You", speaking: false, speakingNow: false, isSelf: true },
    ]);
  });

  it("matches whole class tokens only", async () => {
    const { readings } = await readTiles([
      tile("p1", "Ada", `${SUSTAINED}x`),
      tile("p2", "Bob", `x${INSTANT}`),
      tile("p3", "Cy", null),
    ]);

    expect(readings.map((reading) => [reading.speaking, reading.speakingNow])).toEqual([
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it("skips tiles without an id and keeps a duplicate id once", async () => {
    const { readings } = await readTiles([
      tile(null, "No id"),
      tile("  ", "Blank id"),
      tile("p1", "Ada"),
      tile("p1", "Ada again"),
      tile(" p2 ", "Bob"),
    ]);

    expect(readings.map((reading) => [reading.participantId, reading.name])).toEqual([
      ["p1", "Ada"],
      ["p2", "Bob"],
    ]);
  });

  it("normalises whitespace in names and reads a missing text as an empty name", async () => {
    const { readings } = await readTiles([tile("p1", "  Ada \n  Lovelace "), tile("p2", null)]);

    expect(readings.map((reading) => reading.name)).toEqual(["Ada Lovelace", ""]);
  });

  it("asks for the id and class attributes and the name span in one read, without any action", async () => {
    const { page, readings } = await readTiles([tile("p1", "Ada")]);

    expect(readings).toHaveLength(1);
    expect(page.actions).toEqual([]);
    expect(GOOGLE_MEET_TILE_ATTRIBUTES).toEqual(["data-participant-id", "class"]);
  });

  it.each(["You", "you ", " YOU"])("flags a tile named %j as the own tile", async (label) => {
    const { readings } = await readTiles([tile("p1", label)]);

    expect(readings[0]?.isSelf).toBe(true);
  });

  it("flags the tile with the typed guest display name as the own tile", async () => {
    const driver = createDriver(GUEST);
    const page = createPage();
    prepareJoin(page, { guest: true, next: "WAITING" });
    await driver.openAndAskToJoin(page, INPUT);
    page.setElements(S.participantTile, [tile("p1", INPUT.displayName), tile("p2", "Bob")]);

    const readings = await driver.readParticipants(page);

    expect(readings.map((reading) => reading.isSelf)).toEqual([true, false]);
  });

  it("does not flag a tile with the request's display name in account mode", async () => {
    const driver = createDriver(ACCOUNT_WITH_STATE);
    const page = createPage();
    prepareJoin(page, { guest: false, next: "WAITING" });
    await driver.openAndAskToJoin(page, INPUT);
    page.setElements(S.participantTile, [tile("p1", INPUT.displayName)]);

    const readings = await driver.readParticipants(page);

    expect(readings[0]?.isSelf).toBe(false);
  });
});

describe("active speakers", () => {
  it("returns the sustained, non-self tiles with their real ids", async () => {
    const page = createPage();
    page.setElements(S.participantTile, [
      tile("p1", "Ada", SUSTAINED),
      tile("p2", "Ada", SUSTAINED),
      tile("p3", "Bob", INSTANT),
      tile("p4", "You", SUSTAINED),
      tile("p5", "Cy"),
    ]);

    expect(await createDriver().readActiveSpeakers(page)).toEqual([
      { participantId: "p1", name: "Ada" },
      { participantId: "p2", name: "Ada" },
    ]);
  });

  it("is empty when nobody is marked", async () => {
    expect(await createDriver().readActiveSpeakers(createPage())).toEqual([]);
  });

  it("turns successive tile readings into speaker events keyed by participant id", async () => {
    const { page, events } = await joinedAs(GUEST, "IN_MEETING");

    for (const rows of [
      [tile("p1", "Ada"), tile("p2", "Bob")],
      [tile("p1", "Ada", SUSTAINED), tile("p2", "Bob")],
      [tile("p1", "Ada"), tile("p2", "Bob", SUSTAINED)],
      [tile("p1", "Ada"), tile("p2", "Bob")],
    ]) {
      page.setElements(S.participantTile, rows);
      await advance(POLL);
    }

    expect(speakerEvents(events)).toEqual([
      speakerEvent("p1", "Ada", true),
      speakerEvent("p1", "Ada", false),
      speakerEvent("p2", "Bob", true),
      speakerEvent("p2", "Bob", false),
    ]);
  });

  it("keeps two tiles with one name as two speakers", async () => {
    const { page, events } = await joinedAs(GUEST, "IN_MEETING");

    page.setElements(S.participantTile, [tile("p1", "Sam", SUSTAINED), tile("p2", "Sam", SUSTAINED)]);
    await advance(POLL);

    expect(speakerEvents(events)).toEqual([speakerEvent("p1", "Sam", true), speakerEvent("p2", "Sam", true)]);
  });

  it("sends one participants event per poll", async () => {
    const { page, events } = await joinedAs(GUEST, "IN_MEETING");
    page.setElements(S.participantTile, [tile("p1", "Ada", INSTANT)]);

    await advance(POLL * 3);

    expect(participantsEvents(events)).toHaveLength(3);
    expect(participantsEvents(events)[0]).toEqual({
      type: "participants",
      participants: [{ participantId: "p1", name: "Ada", isSelf: false, speakingNow: true }],
    });
  });
});

describe("notice", () => {
  const notAttempted = (page: FakeMeetingPage): void => {
    expect(fills(page)).toEqual([]);
    expect(clicks(page)).not.toContain(S.chatSendButton);
    expect(pressedKeys(page)).toEqual([]);
  };
  const errorMessage = (state: { error?: unknown }): string =>
    state.error instanceof Error ? state.error.message : "";

  it("opens the classic chat, fills the exact text and sends it", async () => {
    const page = createPage();
    wireChat(page, "classic");

    await createDriver().postChatMessage(page, NOTICE);

    expect(page.actions).toEqual([
      { type: "click", selector: S.chatButton },
      { type: "fillInAnyFrame", selector: S.chatInput, value: NOTICE },
      { type: "clickInAnyFrame", selector: S.chatSendButton },
    ]);
  });

  it("posts through the embedded chat that lives in a child frame", async () => {
    const page = createPage();
    wireChat(page, "embedded");

    await createDriver().postChatMessage(page, NOTICE);

    expect(page.actions).toEqual([
      { type: "click", selector: S.chatButton },
      { type: "fillInAnyFrame", selector: S.chatInput, value: NOTICE },
      { type: "clickInAnyFrame", selector: S.chatSendButton },
    ]);
  });

  // The chat button toggles the panel, so a click with the panel already open would close it.
  it("does not toggle the panel when it is already open and the composer shows", async () => {
    const page = createPage();
    show(page, ["chatPanelOpen", "chatInput", "chatSendButton"]);
    clearComposerOnSend(page);

    await createDriver().postChatMessage(page, NOTICE);

    expect(page.actions).toEqual([
      { type: "fillInAnyFrame", selector: S.chatInput, value: NOTICE },
      { type: "clickInAnyFrame", selector: S.chatSendButton },
    ]);
  });

  it("does not toggle the panel while it is open but the composer is still rendering, also on a retry", async () => {
    const page = createPage();
    show(page, ["chatPanelOpen"]);
    clearComposerOnSend(page);
    const driver = createDriver();

    const first = track(driver.postChatMessage(page, NOTICE));
    await advance(GOOGLE_MEET_CHAT_INPUT_TIMEOUT_MS);
    expect(first.settled).toBe(true);
    expect(first.error).toBeInstanceOf(Error);
    expect(clicks(page)).toEqual([]);

    const second = track(driver.postChatMessage(page, NOTICE));
    await advance(GOOGLE_MEET_CHAT_INPUT_TIMEOUT_MS / 2);
    page.setVisibleInChildFrame(S.chatInput);
    page.setVisibleInChildFrame(S.chatSendButton);
    await advance(1);

    expect(second.settled).toBe(true);
    expect(second.error).toBeUndefined();
    expect(clicks(page)).toEqual([S.chatSendButton]);
  });

  it("fails without filling or sending when the composer never appears", async () => {
    const page = createPage();

    const posting = track(createDriver().postChatMessage(page, NOTICE));
    await advance(GOOGLE_MEET_CHAT_INPUT_TIMEOUT_MS - 1);
    expect(posting.settled).toBe(false);
    await advance(1);

    expect(posting.settled).toBe(true);
    expect(posting.error).toBeInstanceOf(Error);
    expect(errorMessage(posting)).toContain("notice was not posted");
    expect(errorMessage(posting)).not.toContain(NOTICE);
    expect(clicks(page)).toEqual([S.chatButton]);
    notAttempted(page);
  });

  it("rejects when the send is not confirmed by an emptied composer", async () => {
    const page = createPage();
    show(page, ["chatPanelOpen", "chatInput", "chatSendButton"]);

    const posting = track(createDriver().postChatMessage(page, NOTICE));
    await advance(GOOGLE_MEET_CHAT_SENT_TIMEOUT_MS - 1);
    expect(posting.settled).toBe(false);
    await advance(1);

    expect(posting.settled).toBe(true);
    expect(errorMessage(posting)).toMatch(/not confirmed/);
    expect(errorMessage(posting)).not.toContain(NOTICE);
    expect(clicks(page)).toEqual([S.chatSendButton]);
    expect(pressedKeys(page)).toEqual([]);
  });

  it("throws without sending when the fill does not take", async () => {
    const page = createPage();
    show(page, ["chatPanelOpen", "chatInput", "chatSendButton"]);
    page.onAction((action) => {
      if (action.type === "fillInAnyFrame") page.setValue(S.chatInput, "");
    });

    const posting = track(createDriver().postChatMessage(page, NOTICE));
    await advance(1);

    expect(posting.settled).toBe(true);
    expect(errorMessage(posting)).toContain("did not take the text");
    expect(errorMessage(posting)).not.toContain(NOTICE);
    expect(clicks(page)).toEqual([]);
    expect(pressedKeys(page)).toEqual([]);
  });

  describe("when the send button never shows", () => {
    const setup = (): FakeMeetingPage => {
      const page = createPage();
      show(page, ["chatPanelOpen"]);
      page.setVisibleInChildFrame(S.chatInput);
      return page;
    };

    it("presses Enter once after the ready timeout and resolves when the composer empties", async () => {
      const page = setup();
      page.onAction((action) => {
        if (action.type === "pressKey" && action.key === "Enter") page.setValue(S.chatInput, "");
      });

      const posting = track(createDriver().postChatMessage(page, NOTICE));
      await advance(GOOGLE_MEET_CHAT_SEND_READY_TIMEOUT_MS - 1);
      expect(posting.settled).toBe(false);
      expect(pressedKeys(page)).toEqual([]);
      await advance(1);
      await advance(GOOGLE_MEET_CHAT_SENT_POLL_MS);

      expect(posting.settled).toBe(true);
      expect(posting.error).toBeUndefined();
      expect(pressedKeys(page)).toEqual(["Enter"]);
      expect(clicks(page)).toEqual([]);
    });

    it("throws when Enter does not empty the composer", async () => {
      const page = setup();

      const posting = track(createDriver().postChatMessage(page, NOTICE));
      await advance(GOOGLE_MEET_CHAT_SEND_READY_TIMEOUT_MS);
      await advance(GOOGLE_MEET_CHAT_SENT_TIMEOUT_MS);

      expect(posting.settled).toBe(true);
      expect(errorMessage(posting)).toMatch(/not confirmed/);
      expect(pressedKeys(page)).toEqual(["Enter"]);
      expect(clicks(page)).toEqual([]);
    });
  });

  it("does not post twice when a late confirmation shows on the next attempt", async () => {
    const page = createPage();
    show(page, ["chatPanelOpen", "chatInput", "chatSendButton"]);
    const driver = createDriver();

    const first = track(driver.postChatMessage(page, NOTICE));
    await advance(GOOGLE_MEET_CHAT_SENT_TIMEOUT_MS);
    expect(first.settled).toBe(true);
    expect(first.error).toBeInstanceOf(Error);
    page.setValue(S.chatInput, "");
    const actionsAfterFirst = page.actions.length;

    await driver.postChatMessage(page, NOTICE);

    expect(page.actions.length).toBe(actionsAfterFirst);
    expect(fills(page)).toEqual([S.chatInput]);
    expect(clicks(page)).toEqual([S.chatSendButton]);
    expect(pressedKeys(page)).toEqual([]);
  });

  it("fills and sends once more when the text is still in the composer on the next attempt", async () => {
    const page = createPage();
    show(page, ["chatPanelOpen", "chatInput", "chatSendButton"]);
    const driver = createDriver();

    const first = track(driver.postChatMessage(page, NOTICE));
    await advance(GOOGLE_MEET_CHAT_SENT_TIMEOUT_MS);
    expect(first.error).toBeInstanceOf(Error);
    clearComposerOnSend(page);

    await driver.postChatMessage(page, NOTICE);

    expect(fillActions(page)).toEqual([
      { type: "fillInAnyFrame", selector: S.chatInput, value: NOTICE },
      { type: "fillInAnyFrame", selector: S.chatInput, value: NOTICE },
    ]);
    expect(clicks(page)).toEqual([S.chatSendButton, S.chatSendButton]);
    expect(pressedKeys(page)).toEqual([]);
  });

  it("posts the notice on the meeting page", async () => {
    const { adapter, page } = await admittedGuest();
    wireChat(page);

    await adapter.postChatMessage(NOTICE);

    expect(fillActions(page)).toContainEqual({
      type: "fillInAnyFrame",
      selector: S.chatInput,
      value: NOTICE,
    });
    expect(clicks(page).at(-1)).toBe(S.chatSendButton);
  });
});

describe("leave", () => {
  it("clicks the leave button when it is shown", async () => {
    const page = createPage();
    show(page, ["leaveCallButton"]);

    await createDriver().leave(page);

    expect(page.actions).toEqual([{ type: "click", selector: S.leaveCallButton }]);
  });

  it("returns without a click when it is not shown", async () => {
    const page = createPage();

    await createDriver().leave(page);

    expect(page.actions).toEqual([]);
  });

  it("warns once with only the selector key when the control is not shown", async () => {
    const { logger, lines } = createCapturingLogger();
    const page = createPage();

    await new GoogleMeetPageDriver({ google: GUEST, logger }).leave(page);

    expect(page.actions).toEqual([]);
    const warnings = lines.filter((line) => line.includes('"level":"warn"'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("leave control not visible");
    expect(warnings[0]).toContain('"selectorKey":"leaveCallButton"');
    expect(warnings[0]).not.toContain(S.leaveCallButton);
  });

  it("logs the click after it, without the selector string", async () => {
    const { logger, lines } = createCapturingLogger();
    const page = createPage();
    show(page, ["leaveCallButton"]);

    await new GoogleMeetPageDriver({ google: GUEST, logger }).leave(page);

    expect(page.actions).toEqual([{ type: "click", selector: S.leaveCallButton }]);
    const infos = lines.filter((line) => line.includes("clicked the leave control"));
    expect(infos.length).toBe(1);
    expect(infos[0]).toContain('"level":"info"');
    expect(infos[0]).not.toContain(S.leaveCallButton);
    expect(lines.filter((line) => line.includes('"level":"warn"'))).toEqual([]);
  });

  it("leaves through the page, then closes it", async () => {
    const { adapter, page } = await admittedGuest();
    show(page, ["leaveCallButton"]);

    await adapter.leave();

    expect(page.actions.slice(-2)).toEqual([
      { type: "click", selector: S.leaveCallButton },
      { type: "close" },
    ]);
    const actionsAfterLeave = page.actions.length;

    await adapter.leave();

    expect(page.actions.length).toBe(actionsAfterLeave);
  });
});

describe("reconnect", () => {
  it("opens a new page and repeats the whole join", async () => {
    const ctx = await lostGuest();
    expect(eventTypes(ctx.events)).toEqual(["waiting", "admitted", "participants", "connection_lost"]);
    const second = enqueueSecondPage(ctx, "IN_MEETING");

    expect(await ctx.adapter.reconnect()).toBe(true);
    await advance(POLL * 3);

    expect(ctx.launcher.openCalls.length).toBe(2);
    expect(ctx.page.closed).toBe(true);
    expect(gotos(second)).toEqual([INPUT.meetingUrl]);
    expect(clicks(second)).toEqual([S.turnOffMicrophone, S.turnOffCamera, S.askToJoinButton]);
    expect(fillActions(second)).toEqual([
      { type: "fill", selector: S.guestNameInput, value: INPUT.displayName },
    ]);
    expect(eventTypes(ctx.events)).toEqual([
      "waiting",
      "admitted",
      "participants",
      "connection_lost",
      "participants",
      "participants",
      "participants",
    ]);
  });

  it("rejoins through Switch here when the lost connection still lingers in the call", async () => {
    const ctx = await joinedAs(ACCOUNT_WITH_STATE, "IN_MEETING");
    await advance(POLL);
    expect(eventTypes(ctx.events)).toContain("admitted");
    ctx.page.triggerClosed();
    const second = createPage();
    prepareJoin(second, { guest: false, next: "IN_MEETING" });
    show(second, ["askToJoinButton", "turnOffMicrophone", "turnOffCamera"], false);
    show(second, ["switchHereButton"]);
    ctx.launcher.enqueuePage(second);

    expect(await ctx.adapter.reconnect()).toBe(true);

    expect(clicks(second)).toEqual([S.switchHereButton]);
  });

  it("resolves false when the meeting refuses the bot", async () => {
    const ctx = await lostGuest();
    const second = enqueueSecondPage(ctx, "DENIED");

    expect(await ctx.adapter.reconnect()).toBe(false);

    expect(second.closed).toBe(true);
  });

  // Whether to repeat the notice is the runner's decision, not the adapter's.
  it("posts no notice by itself after a reconnect", async () => {
    const ctx = await lostGuest();
    const second = enqueueSecondPage(ctx, "IN_MEETING");
    wireChat(second);

    expect(await ctx.adapter.reconnect()).toBe(true);
    await advance(POLL * 3);

    expect(fills(second)).not.toContain(S.chatInput);
    expect(clicks(second)).not.toContain(S.chatButton);
    expect(clicks(second)).not.toContain(S.chatSendButton);
  });
});

describe("only permitted actions", () => {
  it("a whole meeting clicks exactly the permitted controls", async () => {
    const ctx = setupAdapter();
    prepareJoin(ctx.page, { guest: true, next: "WAITING" });
    show(ctx.page, ["dialogContinueWithoutDevices"]);
    wireDialog(ctx.page, "dialogContinueWithoutDevices");
    wireChat(ctx.page);

    await ctx.adapter.join(INPUT, ctx.handlers);
    await advance(POLL);
    showState(ctx.page, "IN_MEETING");
    show(ctx.page, ["leaveCallButton"]);
    ctx.page.setText(S.participantCountBadge, "3");
    ctx.page.setElements(S.participantTile, [tile("p1", FAKE_SPEAKER, SUSTAINED)]);
    await advance(POLL);
    await ctx.adapter.postChatMessage(NOTICE);
    await advance(POLL * 20);
    await ctx.adapter.leave();

    expect(eventTypes(ctx.events)).toContain("admitted");
    expect(clicks(ctx.page)).toEqual([
      S.dialogContinueWithoutDevices,
      S.turnOffMicrophone,
      S.turnOffCamera,
      S.askToJoinButton,
      S.chatButton,
      S.chatSendButton,
      S.leaveCallButton,
    ]);
    expect(fills(ctx.page)).toEqual([S.guestNameInput, S.chatInput]);
    expect(pressedKeys(ctx.page)).toEqual([]);
  });

  it("polling performs no action", async () => {
    const { page, events } = await joinedAs(GUEST, "IN_MEETING");
    page.setText(S.participantCountBadge, "3");
    page.setElements(S.participantTile, [tile("p1", FAKE_SPEAKER, SUSTAINED)]);
    await advance(POLL);
    const actionsAfterAdmission = page.actions.length;

    await advance(POLL * 20);

    expect(new Set(eventTypes(events))).toEqual(
      new Set(["admitted", "participant_count", "participants", "speaker"])
    );
    expect(page.actions.length).toBe(actionsAfterAdmission);
  });

  it("logs carry no URL, name, text or credential", async () => {
    const { logger, lines } = createCapturingLogger();
    const ctx = setupAdapter(ACCOUNT_WITH_PASSWORD, { logger });
    wireSignIn(ctx.page);
    prepareJoin(ctx.page, { guest: false, next: "IN_MEETING" });
    wireChat(ctx.page);

    await ctx.adapter.join(INPUT, ctx.handlers);
    ctx.page.setElements(S.participantTile, [tile(FAKE_ID, FAKE_SPEAKER, `${SUSTAINED} ${INSTANT}`)]);
    show(ctx.page, ["leaveCallButton"]);
    await advance(POLL);
    await ctx.adapter.postChatMessage(NOTICE);
    await ctx.adapter.leave();

    expect(speakerEvents(ctx.events)).toContainEqual(speakerEvent(FAKE_ID, FAKE_SPEAKER, true));
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    for (const secret of [
      INPUT.meetingUrl,
      INPUT.displayName,
      NOTICE,
      FAKE_EMAIL,
      FAKE_PASSWORD,
      FAKE_SPEAKER,
      FAKE_ID,
      SUSTAINED,
      INSTANT,
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
