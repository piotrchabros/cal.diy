// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAudioCaptureInitScript } from "../audio/captureScript";
import type { Logger } from "../logger";
import { createLogger, createSilentLogger } from "../logger";
import type { MeetingPageDriver, MeetingPageState } from "./browser/BrowserPlatformAdapter";
import { DEFAULT_POLL_INTERVAL_MS } from "./browser/BrowserPlatformAdapter";
import { FakeMeetingBrowserLauncher, FakeMeetingPage } from "./browser/FakeMeetingPage";
import {
  MICROSOFT_TEAMS_SELECTORS,
  MicrosoftTeamsAdapter,
  MicrosoftTeamsPageDriver,
} from "./MicrosoftTeamsAdapter";
import type { PlatformEvent } from "./PlatformAdapter";
import { PlatformLinkUnusableError } from "./PlatformAdapter";

const S = MICROSOFT_TEAMS_SELECTORS;
type SelectorKey = keyof typeof S;

const INPUT = {
  meetingUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0",
  displayName: "Zed Notetaker",
};
const NOTICE = "Heads up: this meeting is being transcribed by Notetaker.";
const SPEAKER_NAME = "Grace Hopper";
const ENTRY_TIMEOUT_MS = 30000;
const POST_JOIN_SETTLE_MS = 5000;
const CHAT_INPUT_TIMEOUT_MS = 3000;
const PEOPLE_PANEL_RETRY_MS = 30000;

const EXPECTED_KEYS = [
  "continueOnThisBrowser",
  "continueWithoutDevices",
  "preJoinNameInput",
  "preJoinMicrophoneOn",
  "preJoinMicrophoneOff",
  "preJoinCameraOn",
  "preJoinCameraOff",
  "preJoinJoinButton",
  "waitingText",
  "deniedText",
  "inMeetingMarker",
  "removedText",
  "meetingEndedText",
  "invalidLinkText",
  "signInRequiredText",
  "chatButton",
  "chatInput",
  "chatSendButton",
  "peopleButton",
  "participantCountBadge",
  "rosterHeading",
  "activeSpeakerName",
  "leaveButton",
] as const satisfies readonly SelectorKey[];

// Held here, not derived from the selector table, so that a selector edit cannot silently shrink the list.
const FORBIDDEN_CONTROLS = [
  "#share-button",
  '[data-tid="share-button"]',
  "#raisehands-button",
  '[data-tid="raisehands-button"]',
  "#reaction-menu-button",
  '[data-tid="reactions-button"]',
  "#callingButtons-showMoreBtn",
  '[data-tid="closed-captions-button"]',
  "#closed-captions-button",
  "#recording-button",
  '[data-tid="recording-button"]',
  '[data-tid="transcription-button"]',
  "#settings-button",
  '[data-tid="settings-button"]',
  '[data-tid="device-settings-button"]',
  "#microphone-button",
  "#video-button",
  'button[aria-label^="Unmute"]',
  'button[aria-label^="Turn camera on"]',
  '[data-tid="hangup-end-meeting"]',
  'button:has-text("End meeting")',
];

const FORBIDDEN_SUBSTRINGS =
  /share|present|raise|hand|reaction|caption|record|transcri|setting|showMore|unmute|turn (camera|mic)\w* on|end[- ]meeting|microphone-button|video-button/i;

const ALLOWED_CLICKS: string[] = [
  S.continueOnThisBrowser,
  S.continueWithoutDevices,
  S.preJoinMicrophoneOn,
  S.preJoinCameraOn,
  S.preJoinJoinButton,
  S.chatButton,
  S.chatSendButton,
  S.peopleButton,
  S.leaveButton,
];
const ALLOWED_FILLS: string[] = [S.preJoinNameInput, S.chatInput];
const TOGGLE_CLICK_TARGETS: string[] = [
  S.preJoinMicrophoneOn,
  S.preJoinMicrophoneOff,
  S.preJoinCameraOn,
  S.preJoinCameraOff,
];

type Toggle = "on" | "off" | "absent";

type PreJoinOptions = {
  launcher?: boolean;
  microphone?: Toggle;
  camera?: Toggle;
  // A stuck toggle ignores the click, like a control that did not react.
  stuck?: { microphone?: boolean; camera?: boolean };
  nameInput?: boolean;
  dialog?: "beforeToggles" | "afterJoin";
  afterJoin?: "lobby" | "inMeeting" | "denied" | "none";
};

function createPreJoinPage(options: PreJoinOptions = {}): FakeMeetingPage {
  const page = new FakeMeetingPage();
  const microphone = options.microphone ?? "off";
  const camera = options.camera ?? "off";
  const nameInput = options.nameInput ?? true;

  const showToggle = (state: Toggle, on: string, off: string): void => {
    if (state === "absent") return;
    page.setVisible(on, state === "on");
    page.setVisible(off, state === "off");
  };
  const showPreJoin = (): void => {
    page.setVisible(S.preJoinJoinButton, true);
    if (nameInput) page.setVisible(S.preJoinNameInput, true);
    showToggle(microphone, S.preJoinMicrophoneOn, S.preJoinMicrophoneOff);
    showToggle(camera, S.preJoinCameraOn, S.preJoinCameraOff);
    if (options.dialog === "beforeToggles") page.setVisible(S.continueWithoutDevices, true);
  };
  const flip = (on: string, off: string): void => {
    page.setVisible(on, false);
    page.setVisible(off, true);
  };
  const joinClicked = (): void => {
    for (const selector of [
      S.preJoinJoinButton,
      S.preJoinNameInput,
      S.preJoinMicrophoneOn,
      S.preJoinMicrophoneOff,
      S.preJoinCameraOn,
      S.preJoinCameraOff,
    ]) {
      page.setVisible(selector, false);
    }
    if (options.afterJoin === "lobby") {
      page.setVisible(S.inMeetingMarker, true);
      page.setVisible(S.waitingText, true);
    }
    if (options.afterJoin === "inMeeting") page.setVisible(S.inMeetingMarker, true);
    if (options.afterJoin === "denied") page.setVisible(S.deniedText, true);
    if (options.dialog === "afterJoin") page.setVisible(S.continueWithoutDevices, true);
  };

  if (options.launcher) page.setVisible(S.continueOnThisBrowser, true);
  else showPreJoin();

  page.onAction((action) => {
    if (action.type !== "click") return;
    if (action.selector === S.continueOnThisBrowser) {
      page.setVisible(S.continueOnThisBrowser, false);
      showPreJoin();
    } else if (action.selector === S.continueWithoutDevices) {
      page.setVisible(S.continueWithoutDevices, false);
    } else if (action.selector === S.preJoinMicrophoneOn) {
      if (!options.stuck?.microphone) flip(S.preJoinMicrophoneOn, S.preJoinMicrophoneOff);
    } else if (action.selector === S.preJoinCameraOn) {
      if (!options.stuck?.camera) flip(S.preJoinCameraOn, S.preJoinCameraOff);
    } else if (action.selector === S.preJoinJoinButton) {
      joinClicked();
    }
  });
  return page;
}

// Hidden until the chat button is clicked, like the real side pane.
function addChat(page: FakeMeetingPage): void {
  page.setVisible(S.chatButton, true);
  page.setVisible(S.chatSendButton, true);
  page.onAction((action) => {
    if (action.type === "click" && action.selector === S.chatButton) page.setVisible(S.chatInput, true);
  });
}

function showForbiddenControls(page: FakeMeetingPage): void {
  for (const selector of FORBIDDEN_CONTROLS) page.setVisible(selector, true);
}

const clicks = (page: FakeMeetingPage): string[] =>
  page.actions.flatMap((action) => (action.type === "click" ? [action.selector] : []));
const fills = (page: FakeMeetingPage): { selector: string; value: string }[] =>
  page.actions.flatMap((action) =>
    action.type === "fill" ? [{ selector: action.selector, value: action.value }] : []
  );
const keys = (page: FakeMeetingPage): string[] =>
  page.actions.flatMap((action) => (action.type === "pressKey" ? [action.key] : []));
const joinClickIndex = (page: FakeMeetingPage): number =>
  page.actions.findIndex((action) => action.type === "click" && action.selector === S.preJoinJoinButton);
const types = (events: PlatformEvent[]): string[] => events.map((event) => event.type);

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

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level: "debug", write: (line) => lines.push(line) }), lines };
}

const newDriver = (logger: Logger = createSilentLogger()): MicrosoftTeamsPageDriver =>
  new MicrosoftTeamsPageDriver({ logger });

function setupAdapter(pages: FakeMeetingPage[], logger: Logger = createSilentLogger()) {
  const launcher = new FakeMeetingBrowserLauncher({ pages });
  const adapter = new MicrosoftTeamsAdapter({
    browser: launcher,
    chrome: { channel: "chrome", headless: false },
    logger,
  });
  const events: PlatformEvent[] = [];
  const handlers = {
    onEvent: (event: PlatformEvent) => {
      events.push(event);
    },
    onAudioFrame: () => {},
  };
  return { adapter, launcher, events, handlers };
}

function createLifecyclePage(): FakeMeetingPage {
  const page = createPreJoinPage({ launcher: true, microphone: "on", camera: "on", afterJoin: "lobby" });
  addChat(page);
  page.setVisible(S.peopleButton, true);
  showForbiddenControls(page);
  return page;
}

// Join, lobby, admission, the people-panel fallback, a notice, speakers, a loss, a reconnect and a leave.
async function runLifecycle(logger: Logger) {
  const first = createLifecyclePage();
  const second = createLifecyclePage();
  const { adapter, events, handlers } = setupAdapter([first, second], logger);

  await adapter.join(INPUT, handlers);
  await advance(DEFAULT_POLL_INTERVAL_MS);
  first.setVisible(S.waitingText, false);
  first.setTexts(S.activeSpeakerName, [SPEAKER_NAME]);
  await advance(PEOPLE_PANEL_RETRY_MS + 5000);
  await adapter.postChatMessage(NOTICE);

  first.triggerClosed();
  const reconnect = track(adapter.reconnect());
  await advance(1000);
  second.setVisible(S.waitingText, false);
  await advance(1000);
  await adapter.leave();

  return { pages: [first, second], events, reconnect };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("selectors", () => {
  it("has every key, each a non-empty string", () => {
    for (const key of EXPECTED_KEYS) {
      expect(typeof S[key]).toBe("string");
      expect(S[key].length).toBeGreaterThan(0);
    }
  });

  it("holds no value that names a forbidden control", () => {
    for (const value of Object.values(S)) {
      expect(value).not.toMatch(FORBIDDEN_SUBSTRINGS);
      expect(FORBIDDEN_CONTROLS).not.toContain(value);
    }
  });

  it("limits the microphone and camera click targets to controls that are currently on", () => {
    expect(S.preJoinMicrophoneOn).toContain('[aria-checked="true"]');
    expect(S.preJoinCameraOn).toContain('[aria-checked="true"]');
  });
});

describe("driver: joining", () => {
  it("reports its platform and has no sign-in step", () => {
    const driver: MeetingPageDriver = newDriver();

    expect(driver.platform).toBe("MICROSOFT_TEAMS");
    expect(driver.signIn).toBeUndefined();
  });

  it("navigates to exactly the given URL as its first action", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(page.actions[0]).toEqual({ type: "goto", url: INPUT.meetingUrl });
    expect(page.actions.filter((action) => action.type === "goto").length).toBe(1);
  });

  it("does not repeat the URL check of the controller", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });
    const meetingUrl = "https://example.org/some/other/place";

    await newDriver().openAndAskToJoin(page, { ...INPUT, meetingUrl });

    expect(page.actions[0]).toEqual({ type: "goto", url: meetingUrl });
  });

  it("clicks the launcher choice before anything else on the pre-join", async () => {
    const page = createPreJoinPage({ launcher: true, afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)[0]).toBe(S.continueOnThisBrowser);
  });

  it("never clicks the launcher choice when the pre-join is shown at once", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)).not.toContain(S.continueOnThisBrowser);
  });

  it("clicks in the fixed order with both devices on and fills the name before the join", async () => {
    const page = createPreJoinPage({
      launcher: true,
      microphone: "on",
      camera: "on",
      afterJoin: "inMeeting",
    });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)).toEqual([
      S.continueOnThisBrowser,
      S.preJoinMicrophoneOn,
      S.preJoinCameraOn,
      S.preJoinJoinButton,
    ]);
    const fillIndex = page.actions.findIndex((action) => action.type === "fill");
    expect(fillIndex).toBeGreaterThan(-1);
    expect(fillIndex).toBeLessThan(joinClickIndex(page));
  });

  it("clicks no toggle when the microphone and camera are already off, and still joins", async () => {
    const page = createPreJoinPage({ microphone: "off", camera: "off", afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page).filter((selector) => TOGGLE_CLICK_TARGETS.includes(selector))).toEqual([]);
    expect(clicks(page)).toContain(S.preJoinJoinButton);
  });

  it("clicks exactly one toggle when only the camera is on", async () => {
    const page = createPreJoinPage({ microphone: "off", camera: "on", afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page).filter((selector) => TOGGLE_CLICK_TARGETS.includes(selector))).toEqual([
      S.preJoinCameraOn,
    ]);
  });

  it("refuses to join when the microphone stays on after the click", async () => {
    const page = createPreJoinPage({ microphone: "on", camera: "off", stuck: { microphone: true } });

    await expect(newDriver().openAndAskToJoin(page, INPUT)).rejects.toThrow(/microphone/i);

    expect(clicks(page)).not.toContain(S.preJoinJoinButton);
  });

  it("refuses to join when the camera stays on after the click", async () => {
    const page = createPreJoinPage({ microphone: "on", camera: "on", stuck: { camera: true } });

    await expect(newDriver().openAndAskToJoin(page, INPUT)).rejects.toThrow(/camera/i);

    expect(clicks(page)).not.toContain(S.preJoinJoinButton);
  });

  it("joins anyway and warns once when a toggle cannot be found at all", async () => {
    const { logger, lines } = recordingLogger();
    const page = createPreJoinPage({ microphone: "absent", camera: "off", afterJoin: "inMeeting" });

    await newDriver(logger).openAndAskToJoin(page, INPUT);

    expect(clicks(page)).toContain(S.preJoinJoinButton);
    const warnings = lines.map((line) => JSON.parse(line)).filter((entry) => entry.level === "warn");
    expect(warnings.length).toBe(1);
    expect(warnings[0].control).toBe("microphone");
    for (const line of lines) {
      expect(line).not.toContain(INPUT.displayName);
      expect(line).not.toContain(INPUT.meetingUrl);
    }
  });

  it("types the display name into the name field", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(fills(page)).toEqual([{ selector: S.preJoinNameInput, value: INPUT.displayName }]);
  });

  it("refuses to join when the name field is missing", async () => {
    const page = createPreJoinPage({ nameInput: false });

    await expect(newDriver().openAndAskToJoin(page, INPUT)).rejects.toThrow(/name/i);

    expect(clicks(page)).not.toContain(S.preJoinJoinButton);
    expect(fills(page)).toEqual([]);
  });

  it("dismisses the device dialog when it shows before the toggles", async () => {
    const page = createPreJoinPage({ dialog: "beforeToggles", afterJoin: "inMeeting" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)).toEqual([S.continueWithoutDevices, S.preJoinJoinButton]);
  });

  it("dismisses the device dialog once when it appears after the join click", async () => {
    const page = createPreJoinPage({ dialog: "afterJoin" });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)).toEqual([S.preJoinJoinButton, S.continueWithoutDevices]);
  });

  it.each<[string, SelectorKey]>([
    ["an invalid link", "invalidLinkText"],
    ["a tenant that requires sign-in", "signInRequiredText"],
  ])("resolves without clicking or filling anything on %s at entry", async (_label, key) => {
    const page = new FakeMeetingPage();
    page.setVisible(S[key], true);

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)).toEqual([]);
    expect(fills(page)).toEqual([]);
  });

  it("resolves when the invalid-link text appears after the launcher click", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.continueOnThisBrowser, true);
    page.onAction((action) => {
      if (action.type !== "click" || action.selector !== S.continueOnThisBrowser) return;
      page.setVisible(S.continueOnThisBrowser, false);
      page.setVisible(S.invalidLinkText, true);
    });

    await newDriver().openAndAskToJoin(page, INPUT);

    expect(clicks(page)).toEqual([S.continueOnThisBrowser]);
    expect(fills(page)).toEqual([]);
  });

  it("rejects with a plain error when no join screen ever shows", async () => {
    const page = new FakeMeetingPage();

    const result = track(newDriver().openAndAskToJoin(page, INPUT));
    await advance(ENTRY_TIMEOUT_MS - 1);
    expect(result.settled).toBe(false);
    await advance(1);

    expect(result.settled).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(PlatformLinkUnusableError);
    expect(clicks(page)).toEqual([]);
  });

  it("rejects without an unhandled rejection when the page closes while waiting", async () => {
    const page = new FakeMeetingPage();

    const result = track(newDriver().openAndAskToJoin(page, INPUT));
    await advance(1000);
    page.triggerClosed();
    await advance(ENTRY_TIMEOUT_MS);

    expect(result.settled).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("returns when nothing follows the join click", async () => {
    const page = createPreJoinPage({ afterJoin: "none" });

    const result = track(newDriver().openAndAskToJoin(page, INPUT));
    await advance(POST_JOIN_SETTLE_MS - 1);
    expect(result.settled).toBe(false);
    await advance(1);

    expect(result.settled).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe("driver: readState", () => {
  const ROWS: [string, SelectorKey[], MeetingPageState][] = [
    ["nothing", [], "UNKNOWN"],
    ["the launcher choice", ["continueOnThisBrowser"], "PRE_JOIN"],
    ["the join button", ["preJoinJoinButton"], "PRE_JOIN"],
    ["the waiting text", ["waitingText"], "WAITING"],
    ["the marker and the waiting text", ["inMeetingMarker", "waitingText"], "WAITING"],
    ["the marker", ["inMeetingMarker"], "IN_MEETING"],
    ["the marker and a removed text", ["inMeetingMarker", "removedText"], "IN_MEETING"],
    ["the marker and an ended text", ["inMeetingMarker", "meetingEndedText"], "IN_MEETING"],
    ["the removed text", ["removedText"], "REMOVED"],
    ["the removed and ended texts", ["removedText", "meetingEndedText"], "REMOVED"],
    ["the ended text", ["meetingEndedText"], "ENDED"],
    ["the denied text", ["deniedText"], "DENIED"],
    ["the denied and waiting texts", ["deniedText", "waitingText"], "DENIED"],
    ["the invalid-link text", ["invalidLinkText"], "LINK_INVALID"],
    ["the sign-in-required text", ["signInRequiredText"], "LINK_INVALID"],
    ["the invalid-link text and the join button", ["invalidLinkText", "preJoinJoinButton"], "LINK_INVALID"],
  ];

  it.each(ROWS)("reads %s as its state", async (_label, visible, expected) => {
    const page = new FakeMeetingPage();
    for (const key of visible) page.setVisible(S[key], true);

    expect(await newDriver().readState(page)).toBe(expected);
  });

  it("performs no mutating action", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.inMeetingMarker, true);
    page.setVisible(S.preJoinJoinButton, true);

    await newDriver().readState(page);

    expect(page.actions).toEqual([]);
  });

  it("propagates a rejected visibility check", async () => {
    const page = new FakeMeetingPage();
    page.setError("isVisible", new Error("page crashed"));

    await expect(newDriver().readState(page)).rejects.toThrow("page crashed");
  });
});

describe("driver: participant count", () => {
  it.each<[string, number | null]>([
    ["3", 3],
    [" 12 ", 12],
    ["99+", 99],
    ["", null],
    ["People", null],
  ])("parses the badge text %j", async (text, expected) => {
    const page = new FakeMeetingPage();
    page.setText(S.participantCountBadge, text);

    expect(await newDriver().readParticipantCount(page)).toBe(expected);
  });

  it.each<[string, number | null]>([
    ["In this meeting (4)", 4],
    ["In this meeting", null],
  ])("falls back to the roster heading %j", async (text, expected) => {
    const page = new FakeMeetingPage();
    page.setText(S.rosterHeading, text);

    expect(await newDriver().readParticipantCount(page)).toBe(expected);
  });

  it("prefers the badge over the heading and clicks nothing when either is readable", async () => {
    const page = new FakeMeetingPage();
    page.setText(S.participantCountBadge, "3");
    page.setText(S.rosterHeading, "In this meeting (4)");
    page.setVisible(S.peopleButton, true);

    expect(await newDriver().readParticipantCount(page)).toBe(3);
    expect(page.actions).toEqual([]);
  });

  it("opens the people panel at most once per throttle window", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.peopleButton, true);
    const driver = newDriver();

    expect(await driver.readParticipantCount(page)).toBeNull();
    expect(clicks(page)).toEqual([S.peopleButton]);

    await advance(1000);
    expect(await driver.readParticipantCount(page)).toBeNull();
    expect(clicks(page).length).toBe(1);

    await advance(PEOPLE_PANEL_RETRY_MS + 1 - 1000);
    expect(await driver.readParticipantCount(page)).toBeNull();
    expect(clicks(page)).toEqual([S.peopleButton, S.peopleButton]);
  });

  it("returns null without any action when there is no people button", async () => {
    const page = new FakeMeetingPage();

    expect(await newDriver().readParticipantCount(page)).toBeNull();
    expect(page.actions).toEqual([]);
  });

  it("does not open the people panel while a chat post is in flight", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.chatButton, true);
    page.setVisible(S.peopleButton, true);
    const driver = newDriver();

    const posting = track(driver.postChatMessage(page, NOTICE));
    await advance(1);
    expect(posting.settled).toBe(false);

    expect(await driver.readParticipantCount(page)).toBeNull();
    expect(clicks(page)).toEqual([S.chatButton]);

    page.setVisible(S.chatInput, true);
    await advance(1);
    expect(posting.settled).toBe(true);
    expect(posting.error).toBeUndefined();

    expect(await driver.readParticipantCount(page)).toBeNull();
    expect(clicks(page)).toContain(S.peopleButton);
  });

  it("keeps the throttle per page", async () => {
    const first = new FakeMeetingPage();
    const second = new FakeMeetingPage();
    first.setVisible(S.peopleButton, true);
    second.setVisible(S.peopleButton, true);
    const driver = newDriver();

    await driver.readParticipantCount(first);
    await driver.readParticipantCount(second);

    expect(clicks(first)).toEqual([S.peopleButton]);
    expect(clicks(second)).toEqual([S.peopleButton]);
  });
});

describe("driver: speakers", () => {
  it("trims and collapses names and derives the id from the name", async () => {
    const page = new FakeMeetingPage();
    page.setTexts(S.activeSpeakerName, ["  Ada  Lovelace ", "Bob"]);

    expect(await newDriver().readActiveSpeakers(page)).toEqual([
      { participantId: "name:ada lovelace", name: "Ada Lovelace" },
      { participantId: "name:bob", name: "Bob" },
    ]);
  });

  it("reports a repeated name once, drops empty texts and returns an empty list for nothing", async () => {
    const page = new FakeMeetingPage();
    const driver = newDriver();
    expect(await driver.readActiveSpeakers(page)).toEqual([]);

    page.setTexts(S.activeSpeakerName, ["Ada", "Ada", "  ", "", "\n"]);

    expect(await driver.readActiveSpeakers(page)).toEqual([{ participantId: "name:ada", name: "Ada" }]);
  });

  it("keeps the id stable across case and spacing", async () => {
    const page = new FakeMeetingPage();
    const driver = newDriver();
    page.setTexts(S.activeSpeakerName, ["Ada Lovelace"]);
    const before = await driver.readActiveSpeakers(page);
    page.setTexts(S.activeSpeakerName, ["ADA  LOVELACE"]);
    const after = await driver.readActiveSpeakers(page);

    expect(before.map((speaker) => speaker.participantId)).toEqual(["name:ada lovelace"]);
    expect(after.map((speaker) => speaker.participantId)).toEqual(["name:ada lovelace"]);
  });
});

describe("driver: chat and leave", () => {
  it("opens the chat, fills the text unchanged and clicks send", async () => {
    const page = new FakeMeetingPage();
    addChat(page);

    await newDriver().postChatMessage(page, NOTICE);

    expect(page.actions).toEqual([
      { type: "click", selector: S.chatButton },
      { type: "fill", selector: S.chatInput, value: NOTICE },
      { type: "click", selector: S.chatSendButton },
    ]);
  });

  it("does not click the chat button when the input is already visible", async () => {
    const page = new FakeMeetingPage();
    addChat(page);
    page.setVisible(S.chatInput, true);

    await newDriver().postChatMessage(page, NOTICE);

    expect(clicks(page)).toEqual([S.chatSendButton]);
  });

  it("presses Enter when the send button is not visible", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.chatInput, true);

    await newDriver().postChatMessage(page, NOTICE);

    expect(page.actions).toEqual([
      { type: "fill", selector: S.chatInput, value: NOTICE },
      { type: "pressKey", key: "Enter" },
    ]);
  });

  it("rejects when there is neither a chat button nor an input", async () => {
    const page = new FakeMeetingPage();

    await expect(newDriver().postChatMessage(page, NOTICE)).rejects.toThrow(/chat/i);

    expect(fills(page)).toEqual([]);
  });

  it("rejects after the input wait when the input never appears", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.chatButton, true);

    const result = track(newDriver().postChatMessage(page, NOTICE));
    await advance(CHAT_INPUT_TIMEOUT_MS - 1);
    expect(result.settled).toBe(false);
    await advance(1);

    expect(result.settled).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(fills(page)).toEqual([]);
    expect(keys(page)).toEqual([]);
    expect(clicks(page)).toEqual([S.chatButton]);
  });

  it("clicks the leave button once when it is visible", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.leaveButton, true);

    await newDriver().leave(page);

    expect(clicks(page)).toEqual([S.leaveButton]);
  });

  it("resolves at once without any action when the leave button is not visible", async () => {
    const page = new FakeMeetingPage();

    await newDriver().leave(page);

    expect(page.actions).toEqual([]);
  });
});

describe("adapter", () => {
  it("reports its platform and opens the browser with the chrome settings", async () => {
    const page = createPreJoinPage({ afterJoin: "lobby" });
    const { adapter, launcher, handlers } = setupAdapter([page]);

    expect(adapter.platform).toBe("MICROSOFT_TEAMS");
    await adapter.join(INPUT, handlers);

    expect(launcher.openCalls).toEqual([{ channel: "chrome", headless: false, storageState: null }]);
  });

  it("joins a scripted page with the capture script installed and the fixed click order", async () => {
    const page = createPreJoinPage({ launcher: true, microphone: "on", camera: "on", afterJoin: "lobby" });
    const { adapter, handlers } = setupAdapter([page]);

    await adapter.join(INPUT, handlers);

    expect(page.initScripts).toEqual([buildAudioCaptureInitScript()]);
    expect(clicks(page)).toEqual([
      S.continueOnThisBrowser,
      S.preJoinMicrophoneOn,
      S.preJoinCameraOn,
      S.preJoinJoinButton,
    ]);
    expect(fills(page)).toEqual([{ selector: S.preJoinNameInput, value: INPUT.displayName }]);
  });

  it("reports the lobby, then admission and the participant count", async () => {
    const page = createPreJoinPage({ afterJoin: "lobby" });
    const { adapter, events, handlers } = setupAdapter([page]);
    await adapter.join(INPUT, handlers);
    expect(events).toEqual([]);

    await advance(DEFAULT_POLL_INTERVAL_MS);
    expect(types(events)).toEqual(["waiting"]);

    page.setVisible(S.waitingText, false);
    page.setText(S.participantCountBadge, "2");
    await advance(DEFAULT_POLL_INTERVAL_MS);

    expect(events).toEqual([
      { type: "waiting" },
      { type: "admitted" },
      { type: "participant_count", count: 2 },
    ]);
  });

  it("rejects an unusable link with PlatformLinkUnusableError and closes the page", async () => {
    const page = new FakeMeetingPage();
    page.setVisible(S.invalidLinkText, true);
    const { adapter, handlers } = setupAdapter([page]);

    await expect(adapter.join(INPUT, handlers)).rejects.toBeInstanceOf(PlatformLinkUnusableError);

    expect(page.closed).toBe(true);
  });

  it("emits speaker events from the active-speaker tiles", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });
    const { adapter, events, handlers } = setupAdapter([page]);
    await adapter.join(INPUT, handlers);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    page.setTexts(S.activeSpeakerName, ["Ada Lovelace"]);
    await advance(DEFAULT_POLL_INTERVAL_MS);
    page.setTexts(S.activeSpeakerName, []);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    expect(events.filter((event) => event.type === "speaker")).toEqual([
      { type: "speaker", participantId: "name:ada lovelace", name: "Ada Lovelace", speaking: true },
      { type: "speaker", participantId: "name:ada lovelace", name: "Ada Lovelace", speaking: false },
    ]);
  });

  it.each<[string, SelectorKey, string]>([
    ["removal", "removedText", "removed"],
    ["the end of the meeting", "meetingEndedText", "meeting_ended"],
  ])("reports %s once admitted", async (_label, key, expected) => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });
    const { adapter, events, handlers } = setupAdapter([page]);
    await adapter.join(INPUT, handlers);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    page.setVisible(S.inMeetingMarker, false);
    page.setVisible(S[key], true);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    expect(types(events)).toContain(expected);
  });

  it("reports a denial from the lobby", async () => {
    const page = createPreJoinPage({ afterJoin: "lobby" });
    const { adapter, events, handlers } = setupAdapter([page]);
    await adapter.join(INPUT, handlers);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    page.setVisible(S.inMeetingMarker, false);
    page.setVisible(S.waitingText, false);
    page.setVisible(S.deniedText, true);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    expect(types(events)).toEqual(["waiting", "denied"]);
  });

  it("posts the notice text unchanged", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });
    page.setVisible(S.chatInput, true);
    const { adapter, handlers } = setupAdapter([page]);
    await adapter.join(INPUT, handlers);

    await adapter.postChatMessage(NOTICE);

    expect(fills(page)).toContainEqual({ selector: S.chatInput, value: NOTICE });
  });

  it("leaves through the leave button, closes the page, and a second leave adds nothing", async () => {
    const page = createPreJoinPage({ afterJoin: "inMeeting" });
    const { adapter, handlers } = setupAdapter([page]);
    await adapter.join(INPUT, handlers);
    const before = page.actions.length;

    await adapter.leave();

    expect(page.actions.slice(before)).toEqual([
      { type: "click", selector: S.leaveButton },
      { type: "close" },
    ]);
    await adapter.leave();
    expect(page.actions.length).toBe(before + 2);
  });

  it("reconnects through the lobby of a second page without repeating state events", async () => {
    const first = createPreJoinPage({ afterJoin: "lobby" });
    const second = createPreJoinPage({ microphone: "on", camera: "on", afterJoin: "lobby" });
    const { adapter, launcher, events, handlers } = setupAdapter([first, second]);
    await adapter.join(INPUT, handlers);
    await advance(DEFAULT_POLL_INTERVAL_MS);
    first.setVisible(S.waitingText, false);
    first.setText(S.participantCountBadge, "2");
    await advance(DEFAULT_POLL_INTERVAL_MS);
    expect(types(events)).toEqual(["waiting", "admitted", "participant_count"]);

    first.triggerClosed();
    expect(types(events).at(-1)).toBe("connection_lost");

    const reconnect = track(adapter.reconnect());
    await advance(3 * DEFAULT_POLL_INTERVAL_MS);
    expect(reconnect.settled).toBe(false);

    second.setVisible(S.waitingText, false);
    await advance(DEFAULT_POLL_INTERVAL_MS);

    expect(reconnect.settled).toBe(true);
    expect(reconnect.value).toBe(true);
    expect(fills(second)).toEqual([{ selector: S.preJoinNameInput, value: INPUT.displayName }]);
    expect(clicks(second)).toContain(S.preJoinJoinButton);
    expect(launcher.openCalls[1]?.storageState).toBeNull();

    second.setText(S.participantCountBadge, "2");
    await advance(DEFAULT_POLL_INTERVAL_MS);
    expect(types(events).filter((type) => type === "waiting").length).toBe(1);
    expect(types(events).filter((type) => type === "admitted").length).toBe(1);
  });

  it("resolves a reconnect into a denied screen with false", async () => {
    const first = createPreJoinPage({ afterJoin: "inMeeting" });
    const second = createPreJoinPage({ afterJoin: "denied" });
    const { adapter, handlers } = setupAdapter([first, second]);
    await adapter.join(INPUT, handlers);
    await advance(DEFAULT_POLL_INTERVAL_MS);
    first.triggerClosed();

    const reconnect = track(adapter.reconnect());
    await advance(DEFAULT_POLL_INTERVAL_MS);

    expect(reconnect.settled).toBe(true);
    expect(reconnect.value).toBe(false);
  });
});

describe("forbidden controls", () => {
  it("clicks and fills only allowed selectors over a whole lifecycle with every forbidden control visible", async () => {
    const { pages, reconnect } = await runLifecycle(createSilentLogger());

    expect(reconnect.value).toBe(true);
    const [first, second] = pages;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    // Guards against a lifecycle that never reached the paths worth checking.
    expect(clicks(first)).toContain(S.peopleButton);
    expect(fills(first)).toContainEqual({ selector: S.chatInput, value: NOTICE });
    expect(clicks(second)).toContain(S.leaveButton);

    for (const page of pages) {
      for (const selector of clicks(page)) {
        expect(FORBIDDEN_CONTROLS).not.toContain(selector);
        expect(ALLOWED_CLICKS).toContain(selector);
      }
      for (const { selector } of fills(page)) {
        expect(FORBIDDEN_CONTROLS).not.toContain(selector);
        expect(ALLOWED_FILLS).toContain(selector);
      }
      for (const key of keys(page)) expect(key).toBe("Enter");
      expect(page.actions.filter((action) => action.type === "goto").length).toBeLessThanOrEqual(1);
    }
  });

  it("logs no URL, display name, participant name or notice text over the same lifecycle", async () => {
    const { logger, lines } = recordingLogger();

    await runLifecycle(logger);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(INPUT.meetingUrl);
      expect(line).not.toContain("meetup-join");
      expect(line).not.toContain(INPUT.displayName);
      expect(line).not.toContain(SPEAKER_NAME);
      expect(line).not.toContain(NOTICE);
    }
  });
});
