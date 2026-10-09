// @vitest-environment node
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pcm16Frame } from "../../audio/AudioFrame";
import {
  AUDIO_FRAME_BINDING,
  buildAudioCaptureInitScript,
  SOURCE_ACTIVITY_BINDING,
} from "../../audio/captureScript";
import type { Logger } from "../../logger";
import { createLogger, createSilentLogger } from "../../logger";
import type { PlatformEvent, PlatformHandlers, PlatformName } from "../PlatformAdapter";
import { PlatformLinkUnusableError } from "../PlatformAdapter";
import type { MeetingPageDriver, MeetingPageState } from "./BrowserPlatformAdapter";
import {
  BrowserPlatformAdapter,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_UNKNOWN_STATE_GRACE_MS,
  DRIVER_LEAVE_TIMEOUT_MS,
} from "./BrowserPlatformAdapter";
import { FakeMeetingBrowserLauncher, FakeMeetingPage } from "./FakeMeetingPage";
import type { MeetingBrowserOptions, MeetingPage } from "./MeetingPage";

const POLL = 100;
const GRACE = 1000;
const INPUT = { meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Notetaker" };
const BROWSER_OPTIONS: MeetingBrowserOptions = { channel: "chrome", headless: true, storageState: null };
const FRAME_PAYLOAD = Buffer.from(new Int16Array([1, -2, 3]).buffer).toString("base64");
const ACTIVITY_PAYLOAD = [
  { sourceKey: "ssrc:1", level: 0.5 },
  { sourceKey: "csrc:2", level: 0.25 },
];
const SPEAKER_A = { participantId: "p-a", name: "Ada" };
const SPEAKER_B = { participantId: "p-b", name: "Bob" };

type DriverMethod =
  | "signIn"
  | "openAndAskToJoin"
  | "readState"
  | "readParticipantCount"
  | "readActiveSpeakers"
  | "postChatMessage"
  | "leave";

type Speaker = { participantId: string; name: string };

class ScriptedDriver implements MeetingPageDriver {
  state: MeetingPageState = "PRE_JOIN";
  count: number | null = null;
  speakers: Speaker[] = [];
  readonly calls: string[] = [];
  readonly joinInputs: { meetingUrl: string; displayName: string }[] = [];
  readonly chatCalls: { page: MeetingPage; text: string }[] = [];
  readonly stateFor = new Map<MeetingPage, MeetingPageState>();
  readonly errors = new Map<DriverMethod, Error>();
  stateGate: Promise<MeetingPageState> | null = null;
  leaveGate: Promise<void> | null = null;
  onOpenAndAskToJoin: (() => void) | null = null;
  onLeave: (() => void) | null = null;

  constructor(readonly platform: PlatformName = "GOOGLE_MEET") {}

  protected maybeThrow(method: DriverMethod): void {
    const error = this.errors.get(method);
    if (error) throw error;
  }

  async openAndAskToJoin(
    _page: MeetingPage,
    input: { meetingUrl: string; displayName: string }
  ): Promise<void> {
    this.calls.push("openAndAskToJoin");
    this.joinInputs.push(input);
    this.onOpenAndAskToJoin?.();
    this.maybeThrow("openAndAskToJoin");
  }

  async readState(page: MeetingPage): Promise<MeetingPageState> {
    this.calls.push("readState");
    this.maybeThrow("readState");
    if (this.stateGate) return this.stateGate;
    return this.stateFor.get(page) ?? this.state;
  }

  async readParticipantCount(_page: MeetingPage): Promise<number | null> {
    this.calls.push("readParticipantCount");
    this.maybeThrow("readParticipantCount");
    return this.count;
  }

  async readActiveSpeakers(_page: MeetingPage): Promise<Speaker[]> {
    this.calls.push("readActiveSpeakers");
    this.maybeThrow("readActiveSpeakers");
    return this.speakers;
  }

  async postChatMessage(page: MeetingPage, text: string): Promise<void> {
    this.calls.push("postChatMessage");
    this.chatCalls.push({ page, text });
    this.maybeThrow("postChatMessage");
  }

  async leave(_page: MeetingPage): Promise<void> {
    this.calls.push("leave");
    this.onLeave?.();
    this.maybeThrow("leave");
    if (this.leaveGate) await this.leaveGate;
  }
}

class SignInDriver extends ScriptedDriver {
  async signIn(_page: MeetingPage): Promise<void> {
    this.calls.push("signIn");
    this.maybeThrow("signIn");
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHandlers(hooks: { throwOnFirstEvent?: boolean; throwOnFrame?: boolean } = {}): {
  handlers: PlatformHandlers;
  events: PlatformEvent[];
  frames: Pcm16Frame[];
} {
  const events: PlatformEvent[] = [];
  const frames: Pcm16Frame[] = [];
  const handlers: PlatformHandlers = {
    onEvent: (event) => {
      events.push(event);
      if (hooks.throwOnFirstEvent && events.length === 1) throw new Error("fake event handler failure");
    },
    onAudioFrame: (frame) => {
      frames.push(frame);
      if (hooks.throwOnFrame) throw new Error("fake frame handler failure");
    },
  };
  return { handlers, events, frames };
}

type SetupOptions = {
  platform?: PlatformName;
  signIn?: boolean;
  state?: MeetingPageState;
  defaultTimings?: boolean;
  logger?: Logger;
  hooks?: { throwOnFirstEvent?: boolean; throwOnFrame?: boolean };
};

function setup(options: SetupOptions = {}) {
  const driver = options.signIn ? new SignInDriver(options.platform) : new ScriptedDriver(options.platform);
  if (options.state) driver.state = options.state;
  const launcher = new FakeMeetingBrowserLauncher();
  const { handlers, events, frames } = createHandlers(options.hooks);
  const timings = options.defaultTimings ? {} : { pollIntervalMs: POLL, unknownStateGraceMs: GRACE };
  const adapter = new BrowserPlatformAdapter({
    driver,
    browser: launcher,
    browserOptions: BROWSER_OPTIONS,
    logger: options.logger ?? createSilentLogger(),
    ...timings,
  });
  return { adapter, driver, launcher, events, frames, handlers };
}

type Ctx = ReturnType<typeof setup>;

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

async function joined(options: SetupOptions = {}): Promise<Ctx> {
  const ctx = setup(options);
  await ctx.adapter.join(INPUT, ctx.handlers);
  return ctx;
}

const readStateCalls = (driver: ScriptedDriver) => driver.calls.filter((call) => call === "readState").length;
const types = (events: PlatformEvent[]) => events.map((event) => event.type);
const speakerEvents = (events: PlatformEvent[]) => events.filter((event) => event.type === "speaker");
const countEvents = (events: PlatformEvent[]) =>
  events.flatMap((event) => (event.type === "participant_count" ? [event.count] : []));

const speakerEvent = (speaker: Speaker, speaking: boolean): PlatformEvent => ({
  type: "speaker",
  participantId: speaker.participantId,
  name: speaker.name,
  speaking,
});

// Admitted on the first tick, then the page dies; the count of 2 is already known when a reconnect starts.
async function admitAndLose(options: SetupOptions = {}): Promise<Ctx> {
  const ctx = setup({ state: "IN_MEETING", ...options });
  ctx.driver.count = 2;
  await ctx.adapter.join(INPUT, ctx.handlers);
  await advance(POLL);
  ctx.launcher.page(0).triggerClosed();
  return ctx;
}

async function reconnectInto(ctx: Ctx, state: MeetingPageState): Promise<FakeMeetingPage> {
  const second = new FakeMeetingPage();
  ctx.launcher.enqueuePage(second);
  ctx.driver.stateFor.set(second, state);
  return second;
}

async function reconnected(): Promise<{ ctx: Ctx; second: FakeMeetingPage }> {
  const ctx = await admitAndLose();
  const second = await reconnectInto(ctx, "IN_MEETING");
  expect(await ctx.adapter.reconnect()).toBe(true);
  return { ctx, second };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("join", () => {
  it("exposes the driver's platform", () => {
    const { adapter } = setup({ platform: "MICROSOFT_TEAMS" });

    expect(adapter.platform).toBe("MICROSOFT_TEAMS");
  });

  it("opens one page with the given browser options", async () => {
    const { launcher } = await joined({ state: "WAITING" });

    expect(launcher.openCalls).toEqual([BROWSER_OPTIONS]);
    expect(launcher.pages.length).toBe(1);
  });

  it("installs the capture script and both bindings before the driver touches the page", async () => {
    const ctx = setup({ state: "WAITING" });
    let actionsSeenByDriver: string[] = [];
    ctx.driver.onOpenAndAskToJoin = () => {
      actionsSeenByDriver = ctx.launcher.page(0).actions.map((action) => action.type);
    };

    await ctx.adapter.join(INPUT, ctx.handlers);

    const page = ctx.launcher.page(0);
    expect(actionsSeenByDriver).toEqual(["addInitScript", "exposeBinding", "exposeBinding"]);
    expect(page.initScripts).toEqual([buildAudioCaptureInitScript()]);
    expect(page.hasBinding(AUDIO_FRAME_BINDING)).toBe(true);
    expect(page.hasBinding(SOURCE_ACTIVITY_BINDING)).toBe(true);
  });

  it("calls signIn before openAndAskToJoin when the driver has one, and passes the input through", async () => {
    const { driver } = await joined({ signIn: true, state: "WAITING" });

    expect(driver.calls.slice(0, 2)).toEqual(["signIn", "openAndAskToJoin"]);
    expect(driver.joinInputs).toEqual([INPUT]);
  });

  it("works with a driver that has no signIn", async () => {
    const { driver } = await joined({ state: "WAITING" });

    expect(driver.calls[0]).toBe("openAndAskToJoin");
    expect(driver.calls).not.toContain("signIn");
  });

  it("emits nothing before join resolves and nothing until the first poll", async () => {
    const { events } = await joined({ state: "WAITING" });

    expect(events).toEqual([]);
    await advance(POLL - 1);
    expect(events).toEqual([]);
    await advance(1);
    expect(events).toEqual([{ type: "waiting" }]);
  });

  it("rejects with PlatformLinkUnusableError and closes the page when the first read is LINK_INVALID", async () => {
    const ctx = setup({ state: "LINK_INVALID" });

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toBeInstanceOf(PlatformLinkUnusableError);

    expect(ctx.launcher.page(0).closed).toBe(true);
    expect(ctx.driver.calls).not.toContain("leave");
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.events).toEqual([]);
  });

  it("rejects with the launcher's error when the browser cannot open", async () => {
    const ctx = setup({ state: "WAITING" });
    const error = new Error("fake open failure");
    ctx.launcher.setOpenError(error);

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toBe(error);

    expect(ctx.launcher.pages.length).toBe(0);
  });

  it("closes the page and rethrows when signIn throws", async () => {
    const ctx = setup({ signIn: true, state: "WAITING" });
    const error = new Error("fake sign-in failure");
    ctx.driver.errors.set("signIn", error);

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toBe(error);

    expect(ctx.launcher.page(0).closed).toBe(true);
    expect(ctx.driver.calls).not.toContain("openAndAskToJoin");
  });

  it("closes the page and rethrows when openAndAskToJoin throws", async () => {
    const plain = setup({ state: "WAITING" });
    const error = new Error("fake join failure");
    plain.driver.errors.set("openAndAskToJoin", error);

    await expect(plain.adapter.join(INPUT, plain.handlers)).rejects.toBe(error);
    expect(plain.launcher.page(0).closed).toBe(true);

    const unusable = setup({ state: "WAITING" });
    const linkError = new PlatformLinkUnusableError("fake unusable link");
    unusable.driver.errors.set("openAndAskToJoin", linkError);

    await expect(unusable.adapter.join(INPUT, unusable.handlers)).rejects.toBe(linkError);
    expect(unusable.launcher.page(0).closed).toBe(true);
  });

  it("closes the page and rethrows when the first state read throws", async () => {
    const ctx = setup({ state: "WAITING" });
    const error = new Error("fake read failure");
    ctx.driver.errors.set("readState", error);

    await expect(ctx.adapter.join(INPUT, ctx.handlers)).rejects.toBe(error);

    expect(ctx.launcher.page(0).closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a second join and a join after leave", async () => {
    const first = await joined({ state: "WAITING" });

    await expect(first.adapter.join(INPUT, first.handlers)).rejects.toThrow("join called twice");

    const second = await joined({ state: "WAITING" });
    await second.adapter.leave();

    await expect(second.adapter.join(INPUT, second.handlers)).rejects.toThrow("join called after leave");
  });

  it("closes the page and rejects when leave is called while the browser is opening", async () => {
    const ctx = setup({ state: "WAITING" });
    ctx.launcher.setOpenDelayMs(50);

    const joining = track(ctx.adapter.join(INPUT, ctx.handlers));
    await ctx.adapter.leave();
    await advance(50);

    expect(joining.settled).toBe(true);
    expect(joining.error).toBeInstanceOf(Error);
    expect(ctx.launcher.page(0).closed).toBe(true);
    expect(ctx.events).toEqual([]);
  });
});

describe("state mapping and deduplication", () => {
  it("maps WAITING then IN_MEETING to waiting then admitted, once each", async () => {
    const { driver, events } = await joined({ state: "WAITING" });

    await advance(POLL * 3);
    driver.state = "IN_MEETING";
    await advance(POLL * 3);

    expect(events).toEqual([{ type: "waiting" }, { type: "admitted" }]);
  });

  it("emits admitted without waiting when the first polled state is IN_MEETING", async () => {
    const { events } = await joined({ state: "IN_MEETING" });

    await advance(POLL);

    expect(events).toEqual([{ type: "admitted" }]);
  });

  it("emits nothing for PRE_JOIN", async () => {
    const { events } = await joined({ state: "PRE_JOIN" });

    await advance(POLL * 20);

    expect(events).toEqual([]);
  });

  it("does not repeat waiting after WAITING, PRE_JOIN, WAITING", async () => {
    const { driver, events } = await joined({ state: "WAITING" });

    await advance(POLL);
    driver.state = "PRE_JOIN";
    await advance(POLL);
    driver.state = "WAITING";
    await advance(POLL);

    expect(events).toEqual([{ type: "waiting" }]);
  });

  it("maps DENIED to denied and stops polling", async () => {
    const { driver, launcher, events } = await joined({ state: "WAITING" });
    await advance(POLL);
    driver.state = "DENIED";
    await advance(POLL);
    expect(events).toEqual([{ type: "waiting" }, { type: "denied" }]);
    const readsAtTerminal = readStateCalls(driver);

    await advance(POLL * 10);

    expect(readStateCalls(driver)).toBe(readsAtTerminal);
    expect(events.length).toBe(2);
    expect(launcher.page(0).closed).toBe(false);
  });

  it.each([
    ["REMOVED before admission", "REMOVED", "removed", false],
    ["ENDED before admission", "ENDED", "meeting_ended", false],
    ["REMOVED after admission", "REMOVED", "removed", true],
    ["ENDED after admission", "ENDED", "meeting_ended", true],
  ] as const)("maps %s to its terminal event and stops polling", async (_label, state, eventType, admitFirst) => {
    const { driver, events } = await joined({ state: admitFirst ? "IN_MEETING" : "WAITING" });
    await advance(POLL);
    driver.state = state;
    await advance(POLL);
    const readsAtTerminal = readStateCalls(driver);
    const eventsAtTerminal = events.length;

    await advance(POLL * 10);

    expect(events.at(-1)).toEqual({ type: eventType });
    expect(readStateCalls(driver)).toBe(readsAtTerminal);
    expect(events.length).toBe(eventsAtTerminal);
  });

  it("maps LINK_INVALID seen while polling before admission to denied", async () => {
    const { driver, events } = await joined({ state: "WAITING" });
    await advance(POLL);

    driver.state = "LINK_INVALID";
    await advance(POLL);

    expect(events).toEqual([{ type: "waiting" }, { type: "denied" }]);
  });

  it("ignores a page close after a terminal state", async () => {
    const { driver, launcher, events } = await joined({ state: "IN_MEETING" });
    await advance(POLL);
    driver.state = "REMOVED";
    await advance(POLL);

    launcher.page(0).triggerClosed();

    expect(types(events)).toEqual(["admitted", "removed"]);
  });
});

describe("counts and speakers", () => {
  it("reads count and speakers only in IN_MEETING", async () => {
    const { driver } = await joined({ state: "WAITING" });

    await advance(POLL * 3);

    expect(driver.calls).not.toContain("readParticipantCount");
    expect(driver.calls).not.toContain("readActiveSpeakers");
  });

  it("emits participant_count on the admission tick, then only when it changes", async () => {
    const { driver, events } = await joined({ state: "IN_MEETING" });
    driver.count = 2;
    await advance(POLL);
    expect(types(events)).toEqual(["admitted", "participant_count"]);

    await advance(POLL);
    driver.count = 3;
    await advance(POLL);
    await advance(POLL);
    driver.count = 2;
    await advance(POLL);

    expect(countEvents(events)).toEqual([2, 3, 2]);
  });

  it("skips a null, negative or fractional count", async () => {
    const { driver, events } = await joined({ state: "IN_MEETING" });
    driver.count = 2;
    await advance(POLL);

    for (const invalid of [null, -1, 2.5, Number.NaN]) {
      driver.count = invalid;
      await advance(POLL);
    }
    driver.count = 2;
    await advance(POLL);

    expect(countEvents(events)).toEqual([2]);
  });

  it("turns the difference between two speaker reads into speaker events", async () => {
    const { driver, events } = await joined({ state: "IN_MEETING" });

    for (const read of [[], [SPEAKER_A], [SPEAKER_A, SPEAKER_B], [SPEAKER_B], []]) {
      driver.speakers = read;
      await advance(POLL);
    }

    expect(speakerEvents(events)).toEqual([
      speakerEvent(SPEAKER_A, true),
      speakerEvent(SPEAKER_B, true),
      speakerEvent(SPEAKER_A, false),
      speakerEvent(SPEAKER_B, false),
    ]);
  });

  it("emits stops before starts in one tick", async () => {
    const { driver, events } = await joined({ state: "IN_MEETING" });
    driver.speakers = [SPEAKER_A];
    await advance(POLL);

    driver.speakers = [SPEAKER_B];
    await advance(POLL);

    expect(speakerEvents(events)).toEqual([
      speakerEvent(SPEAKER_A, true),
      speakerEvent(SPEAKER_A, false),
      speakerEvent(SPEAKER_B, true),
    ]);
  });

  it("ignores duplicate ids, empty ids and a renamed speaker", async () => {
    const { driver, events } = await joined({ state: "IN_MEETING" });
    driver.speakers = [
      SPEAKER_A,
      { participantId: "p-a", name: "Duplicate" },
      { participantId: "", name: "Nobody" },
    ];
    await advance(POLL);

    driver.speakers = [{ participantId: "p-a", name: "Renamed" }];
    await advance(POLL);

    expect(speakerEvents(events)).toEqual([speakerEvent(SPEAKER_A, true)]);
  });

  it("closes open speakers before connection_lost and before a terminal event", async () => {
    const lost = await joined({ state: "IN_MEETING" });
    lost.driver.speakers = [SPEAKER_A];
    await advance(POLL);

    lost.launcher.page(0).triggerClosed();

    expect(lost.events.slice(-2)).toEqual([speakerEvent(SPEAKER_A, false), { type: "connection_lost" }]);

    const ended = await joined({ state: "IN_MEETING" });
    ended.driver.speakers = [SPEAKER_A];
    await advance(POLL);
    ended.driver.state = "ENDED";
    await advance(POLL);

    expect(ended.events.slice(-2)).toEqual([speakerEvent(SPEAKER_A, false), { type: "meeting_ended" }]);
  });
});

describe("audio bindings", () => {
  it("forwards a decoded audio frame to onAudioFrame", async () => {
    const { launcher, frames } = await joined({ state: "WAITING" });

    launcher.page(0).triggerBinding(AUDIO_FRAME_BINDING, FRAME_PAYLOAD);

    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]?.samples ?? [])).toEqual([1, -2, 3]);
  });

  it("drops malformed frame and activity payloads", async () => {
    const { launcher, frames, events } = await joined({ state: "WAITING" });
    const page = launcher.page(0);

    for (const payload of [42, "AA==", {}]) {
      expect(() => page.triggerBinding(AUDIO_FRAME_BINDING, payload)).not.toThrow();
      expect(() => page.triggerBinding(SOURCE_ACTIVITY_BINDING, payload)).not.toThrow();
    }

    expect(frames).toEqual([]);
    expect(events).toEqual([]);
  });

  it("turns one activity payload into one source_activity event per entry", async () => {
    const { launcher, events } = await joined({ state: "WAITING" });

    launcher.page(0).triggerBinding(SOURCE_ACTIVITY_BINDING, ACTIVITY_PAYLOAD);

    expect(events).toEqual([
      { type: "source_activity", sourceKey: "ssrc:1", level: 0.5 },
      { type: "source_activity", sourceKey: "csrc:2", level: 0.25 },
    ]);
  });

  it("keeps polling when a handler throws", async () => {
    const throwingEvents = await joined({ state: "WAITING", hooks: { throwOnFirstEvent: true } });
    await advance(POLL);
    const readsAfterThrow = readStateCalls(throwingEvents.driver);

    await advance(POLL * 3);

    expect(readStateCalls(throwingEvents.driver)).toBe(readsAfterThrow + 3);
    expect(throwingEvents.events.map((event) => event.type)).not.toContain("connection_lost");

    const throwingFrames = await joined({ state: "WAITING", hooks: { throwOnFrame: true } });

    expect(() =>
      throwingFrames.launcher.page(0).triggerBinding(AUDIO_FRAME_BINDING, FRAME_PAYLOAD)
    ).not.toThrow();
  });
});

describe("connection loss", () => {
  it("emits connection_lost once when the page closes, and stops polling", async () => {
    const { driver, launcher, events } = await joined({ state: "WAITING" });
    const page = launcher.page(0);

    page.triggerClosed();
    page.triggerClosed();
    const readsAtLoss = readStateCalls(driver);
    await advance(POLL * 10);

    expect(events).toEqual([{ type: "connection_lost" }]);
    expect(readStateCalls(driver)).toBe(readsAtLoss);
  });

  it.each([
    "readState",
    "readParticipantCount",
    "readActiveSpeakers",
  ] as const)("emits connection_lost once when %s throws, then no further polling", async (method) => {
    const { driver, events } = await joined({ state: "IN_MEETING" });
    driver.errors.set(method, new Error("fake read failure"));

    await advance(POLL);
    const readsAtLoss = readStateCalls(driver);
    await advance(POLL * 10);

    expect(events.filter((event) => event.type === "connection_lost").length).toBe(1);
    expect(events.at(-1)).toEqual({ type: "connection_lost" });
    expect(readStateCalls(driver)).toBe(readsAtLoss);
  });

  it("emits connection_lost only after UNKNOWN lasted longer than the grace period", async () => {
    const { events } = await joined({ state: "UNKNOWN" });
    await advance(POLL);

    await advance(GRACE);
    expect(events).toEqual([]);

    await advance(POLL);
    expect(events).toEqual([{ type: "connection_lost" }]);
  });

  it("restarts the grace clock when a known state is read in between", async () => {
    const { driver, events } = await joined({ state: "UNKNOWN" });
    await advance(POLL + 900);

    driver.state = "IN_MEETING";
    await advance(POLL);
    driver.state = "UNKNOWN";
    await advance(POLL + 900);

    expect(types(events)).toEqual(["admitted"]);
  });

  it.each([
    "PRE_JOIN",
    "WAITING",
    "DENIED",
    "LINK_INVALID",
  ] as const)("treats %s after admission as UNKNOWN", async (state) => {
    const { driver, events } = await joined({ state: "IN_MEETING" });
    await advance(POLL);
    driver.state = state;
    await advance(POLL);

    await advance(GRACE);
    expect(types(events)).toEqual(["admitted"]);

    await advance(POLL);
    expect(types(events)).toEqual(["admitted", "connection_lost"]);
  });

  it("uses 500 ms and 15000 ms by default", async () => {
    const waiting = await joined({ defaultTimings: true, state: "WAITING" });
    await advance(DEFAULT_POLL_INTERVAL_MS - 1);
    expect(waiting.events).toEqual([]);
    await advance(1);
    expect(waiting.events).toEqual([{ type: "waiting" }]);

    const unknown = await joined({ defaultTimings: true, state: "UNKNOWN" });
    await advance(DEFAULT_POLL_INTERVAL_MS);
    await advance(DEFAULT_UNKNOWN_STATE_GRACE_MS);
    expect(unknown.events).toEqual([]);
    await advance(DEFAULT_POLL_INTERVAL_MS);
    expect(unknown.events).toEqual([{ type: "connection_lost" }]);
  });

  it("drops audio and activity after a loss, and logs no URL, name or chat text", async () => {
    const lost = await joined({ state: "WAITING" });
    const page = lost.launcher.page(0);
    page.triggerClosed();
    const eventsAtLoss = lost.events.length;

    page.triggerBinding(AUDIO_FRAME_BINDING, FRAME_PAYLOAD);
    page.triggerBinding(SOURCE_ACTIVITY_BINDING, ACTIVITY_PAYLOAD);

    expect(lost.frames).toEqual([]);
    expect(lost.events.length).toBe(eventsAtLoss);

    const lines: string[] = [];
    const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
    const logged = await joined({ state: "IN_MEETING", logger });
    logged.driver.speakers = [{ participantId: "p-ada", name: "Ada Lovelace" }];
    await advance(POLL);
    await logged.adapter.postChatMessage("Fake chat notice text");
    logged.launcher.page(0).triggerClosed();

    expect(logged.events.at(-1)).toEqual({ type: "connection_lost" });
    const output = lines.join("\n");
    expect(output).not.toContain(INPUT.meetingUrl);
    expect(output).not.toContain("Ada Lovelace");
    expect(output).not.toContain("Fake chat notice text");
  });
});

describe("poll loop", () => {
  it("does not start a second read while one is pending", async () => {
    const { driver } = await joined({ state: "WAITING" });
    const gate = createDeferred<MeetingPageState>();
    driver.stateGate = gate.promise;
    const readsAfterJoin = readStateCalls(driver);

    await advance(POLL * 5);
    expect(readStateCalls(driver)).toBe(readsAfterJoin + 1);

    gate.resolve("WAITING");
    await advance(0);
    await advance(POLL);
    expect(readStateCalls(driver)).toBe(readsAfterJoin + 2);
  });

  it("emits nothing from a read that finishes after leave", async () => {
    const { adapter, driver, events } = await joined({ state: "WAITING" });
    const gate = createDeferred<MeetingPageState>();
    driver.stateGate = gate.promise;
    await advance(POLL);

    const leaving = adapter.leave();
    gate.resolve("IN_MEETING");
    await leaving;
    await advance(POLL * 3);

    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("chat", () => {
  it("posts the notice through the driver on the current page", async () => {
    const { adapter, driver, launcher } = await joined({ state: "WAITING" });

    await adapter.postChatMessage("Fake chat notice text");

    expect(driver.chatCalls.length).toBe(1);
    expect(driver.chatCalls[0]?.page).toBe(launcher.page(0));
    expect(driver.chatCalls[0]?.text).toBe("Fake chat notice text");
  });

  it("propagates a driver failure from postChatMessage", async () => {
    const { adapter, driver } = await joined({ state: "WAITING" });
    const error = new Error("fake chat failure");
    driver.errors.set("postChatMessage", error);

    await expect(adapter.postChatMessage("Fake chat notice text")).rejects.toBe(error);
  });

  it("rejects postChatMessage before join, after leave and after a loss", async () => {
    const message = "postChatMessage called while not in a meeting";
    const before = setup({ state: "WAITING" });
    await expect(before.adapter.postChatMessage("Fake chat notice text")).rejects.toThrow(message);

    const left = await joined({ state: "WAITING" });
    await left.adapter.leave();
    await expect(left.adapter.postChatMessage("Fake chat notice text")).rejects.toThrow(message);

    const lost = await joined({ state: "WAITING" });
    lost.launcher.page(0).triggerClosed();
    await expect(lost.adapter.postChatMessage("Fake chat notice text")).rejects.toThrow(message);
    expect(lost.driver.chatCalls).toEqual([]);
  });
});

describe("reconnect", () => {
  it("closes the old page, opens a new one, asks to join again and resolves true on IN_MEETING", async () => {
    const ctx = await admitAndLose();
    const second = await reconnectInto(ctx, "WAITING");

    const result = track(ctx.adapter.reconnect());
    await advance(POLL * 3);
    expect(result.settled).toBe(false);

    ctx.driver.stateFor.set(second, "IN_MEETING");
    await advance(POLL);

    expect(result.value).toBe(true);
    expect(ctx.launcher.page(0).closed).toBe(true);
    expect(ctx.launcher.openCalls.length).toBe(2);
    expect(ctx.driver.joinInputs).toEqual([INPUT, INPUT]);
    expect(second.initScripts).toEqual([buildAudioCaptureInitScript()]);
    expect(second.hasBinding(AUDIO_FRAME_BINDING)).toBe(true);
    expect(second.hasBinding(SOURCE_ACTIVITY_BINDING)).toBe(true);
  });

  it("emits no waiting or admitted event during or after a reconnect", async () => {
    const ctx = await admitAndLose();
    const second = await reconnectInto(ctx, "WAITING");
    const eventsBefore = [...ctx.events];

    const result = track(ctx.adapter.reconnect());
    await advance(POLL * 3);
    expect(ctx.events).toEqual(eventsBefore);

    ctx.driver.stateFor.set(second, "IN_MEETING");
    await advance(POLL);
    expect(result.value).toBe(true);
    await advance(POLL * 3);

    expect(ctx.events).toEqual(eventsBefore);
    expect(types(eventsBefore)).toEqual(["admitted", "participant_count", "connection_lost"]);
  });

  it("resumes polling on the new page", async () => {
    const { ctx, second } = await reconnected();

    ctx.driver.count = 3;
    ctx.driver.speakers = [SPEAKER_A];
    await advance(POLL);
    expect(countEvents(ctx.events)).toEqual([2, 3]);
    expect(speakerEvents(ctx.events)).toEqual([speakerEvent(SPEAKER_A, true)]);

    second.triggerBinding(AUDIO_FRAME_BINDING, FRAME_PAYLOAD);
    expect(ctx.frames.length).toBe(1);

    ctx.launcher.page(0).triggerBinding(AUDIO_FRAME_BINDING, FRAME_PAYLOAD);
    expect(ctx.frames.length).toBe(1);
  });

  it("can report a second loss after a successful reconnect", async () => {
    const { ctx, second } = await reconnected();

    second.triggerClosed();

    expect(ctx.events.filter((event) => event.type === "connection_lost").length).toBe(2);
  });

  it.each([
    "DENIED",
    "REMOVED",
    "ENDED",
    "LINK_INVALID",
  ] as const)("resolves false on %s and closes the new page", async (state) => {
    const ctx = await admitAndLose();
    const second = await reconnectInto(ctx, state);

    expect(await ctx.adapter.reconnect()).toBe(false);

    expect(second.closed).toBe(true);
  });

  it.each([
    [
      "the browser cannot open",
      false,
      async (ctx: Ctx) => {
        ctx.launcher.setOpenError(new Error("fake open failure"));
        return ctx.adapter.reconnect();
      },
    ],
    [
      "openAndAskToJoin throws",
      true,
      async (ctx: Ctx) => {
        ctx.driver.errors.set("openAndAskToJoin", new Error("fake join failure"));
        return ctx.adapter.reconnect();
      },
    ],
    [
      "a read throws",
      true,
      async (ctx: Ctx) => {
        ctx.driver.errors.set("readState", new Error("fake read failure"));
        return ctx.adapter.reconnect();
      },
    ],
    [
      "the new page closes while waiting",
      true,
      async (ctx: Ctx, second: FakeMeetingPage) => {
        ctx.driver.stateFor.set(second, "WAITING");
        const result = ctx.adapter.reconnect();
        await advance(POLL);
        second.triggerClosed();
        return result;
      },
    ],
  ])("resolves false when %s", async (_label, opensPage, scenario) => {
    const ctx = await admitAndLose();
    const second = await reconnectInto(ctx, "IN_MEETING");
    const eventsBefore = [...ctx.events];

    expect(await scenario(ctx, second)).toBe(false);

    expect(second.closed).toBe(opensPage);
    expect(ctx.events).toEqual(eventsBefore);
  });

  it("resolves false after UNKNOWN outlasts the grace period", async () => {
    const ctx = await admitAndLose();
    const second = await reconnectInto(ctx, "UNKNOWN");

    const result = track(ctx.adapter.reconnect());
    await advance(GRACE);
    expect(result.settled).toBe(false);

    await advance(POLL);

    expect(result.value).toBe(false);
    expect(second.closed).toBe(true);
  });

  it("resolves false at once when leave is called while it waits", async () => {
    const ctx = await admitAndLose();
    const second = await reconnectInto(ctx, "WAITING");
    const result = track(ctx.adapter.reconnect());
    await advance(POLL);
    expect(result.settled).toBe(false);

    const leaving = ctx.adapter.leave();
    await advance(0);
    await leaving;

    expect(result.value).toBe(false);
    expect(second.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves false before join, after leave and while another reconnect is running", async () => {
    const before = setup({ state: "WAITING" });
    expect(await before.adapter.reconnect()).toBe(false);
    expect(before.launcher.openCalls.length).toBe(0);

    const left = await joined({ state: "WAITING" });
    await left.adapter.leave();
    expect(await left.adapter.reconnect()).toBe(false);
    expect(left.launcher.openCalls.length).toBe(1);

    const ctx = await admitAndLose();
    await reconnectInto(ctx, "WAITING");
    const first = track(ctx.adapter.reconnect());
    expect(await ctx.adapter.reconnect()).toBe(false);

    await ctx.adapter.leave();
    await advance(0);
    expect(first.value).toBe(false);
  });
});

describe("leave", () => {
  it("asks the driver to leave, then closes the page", async () => {
    const { adapter, driver, launcher } = await joined({ state: "WAITING" });
    let actionsAtDriverLeave: string[] = [];
    driver.onLeave = () => {
      actionsAtDriverLeave = launcher.page(0).actions.map((action) => action.type);
    };

    await adapter.leave();

    expect(driver.calls).toContain("leave");
    expect(actionsAtDriverLeave).not.toContain("close");
    expect(launcher.page(0).actions.at(-1)).toEqual({ type: "close" });
  });

  it("closes the page even when the driver's leave throws", async () => {
    const { adapter, driver, launcher } = await joined({ state: "WAITING" });
    driver.errors.set("leave", new Error("fake leave failure"));

    await expect(adapter.leave()).resolves.toBeUndefined();

    expect(launcher.page(0).closed).toBe(true);
  });

  it("closes the page when the driver's leave does not settle within DRIVER_LEAVE_TIMEOUT_MS", async () => {
    const { adapter, driver, launcher } = await joined({ state: "WAITING" });
    driver.leaveGate = createDeferred<void>().promise;

    const leaving = track(adapter.leave());
    await advance(DRIVER_LEAVE_TIMEOUT_MS - 1);
    expect(leaving.settled).toBe(false);
    expect(launcher.page(0).closed).toBe(false);

    await advance(1);

    expect(leaving.settled).toBe(true);
    expect(leaving.error).toBeUndefined();
    expect(launcher.page(0).closed).toBe(true);
  });

  it("swallows a failing page close", async () => {
    const { adapter, launcher } = await joined({ state: "WAITING" });
    launcher.page(0).setError("close", new Error("fake close failure"));

    await expect(adapter.leave()).resolves.toBeUndefined();
  });

  it("is idempotent", async () => {
    const { adapter, driver, launcher } = await joined({ state: "WAITING" });

    const first = adapter.leave();
    const second = adapter.leave();
    await first;

    expect(second).toBe(first);
    expect(driver.calls.filter((call) => call === "leave").length).toBe(1);
    expect(launcher.page(0).closeCalls).toBe(1);
  });

  it("stops polling and emits nothing afterwards", async () => {
    const { adapter, driver, events } = await joined({ state: "WAITING" });
    await advance(POLL);
    const readsAtLeave = readStateCalls(driver);

    await adapter.leave();
    await advance(POLL * 10);

    expect(readStateCalls(driver)).toBe(readsAtLeave);
    expect(events).toEqual([{ type: "waiting" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the driver's leave when the page already closed", async () => {
    const { adapter, driver, launcher } = await joined({ state: "WAITING" });
    launcher.page(0).triggerClosed();

    await adapter.leave();

    expect(driver.calls).not.toContain("leave");
  });

  it("resolves when called before join", async () => {
    const { adapter, launcher } = setup({ state: "WAITING" });

    await expect(adapter.leave()).resolves.toBeUndefined();

    expect(launcher.openCalls.length).toBe(0);
  });
});
