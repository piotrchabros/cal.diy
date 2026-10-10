// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pcm16Frame } from "../audio/AudioFrame";
import { createSilenceFrame } from "../audio/AudioFrame";
import { FakePlatformAdapter } from "./FakePlatformAdapter";
import type { PlatformAdapter, PlatformEvent, PlatformHandlers } from "./PlatformAdapter";
import { PlatformLinkUnusableError } from "./PlatformAdapter";

const INPUT = { meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Notetaker" };

const ALL_EVENTS: PlatformEvent[] = [
  { type: "waiting" },
  { type: "admitted" },
  { type: "denied" },
  { type: "participant_count", count: 3 },
  { type: "speaker", participantId: "p1", name: "Ada", speaking: true },
  {
    type: "participants",
    participants: [{ participantId: "p1", name: "Ada", isSelf: false, speakingNow: true }],
  },
  { type: "source_activity", sourceKey: "src-1", level: 0.5 },
  { type: "source_identity", sourceKey: "src-1", participantId: "p1", name: "Ada" },
  { type: "removed" },
  { type: "meeting_ended" },
  { type: "connection_lost" },
];

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

async function joinedAdapter(
  options?: ConstructorParameters<typeof FakePlatformAdapter>[0]
): Promise<{ adapter: FakePlatformAdapter; events: PlatformEvent[]; frames: Pcm16Frame[] }> {
  const adapter = new FakePlatformAdapter(options);
  const { handlers, events, frames } = createHandlers();
  await adapter.join(INPUT, handlers);
  return { adapter, events, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("construction", () => {
  it("defaults to Google Meet with empty records and zeroed counters", () => {
    const adapter = new FakePlatformAdapter();

    expect(adapter.platform).toBe("GOOGLE_MEET");
    expect(adapter.joinCalls).toEqual([]);
    expect(adapter.chatMessages).toEqual([]);
    expect(adapter.reconnectCalls).toBe(0);
    expect(adapter.leaveCalls).toBe(0);
  });

  it("reports the configured platform", () => {
    expect(new FakePlatformAdapter({ platform: "MICROSOFT_TEAMS" }).platform).toBe("MICROSOFT_TEAMS");
  });

  it("is assignable to PlatformAdapter", () => {
    const adapter: PlatformAdapter = new FakePlatformAdapter();

    expect(adapter.platform).toBe("GOOGLE_MEET");
  });
});

describe("join", () => {
  it("resolves and records a copy of the input", async () => {
    const adapter = new FakePlatformAdapter();
    const { handlers } = createHandlers();

    await expect(adapter.join(INPUT, handlers)).resolves.toBeUndefined();

    expect(adapter.joinCalls).toHaveLength(1);
    expect(adapter.joinCalls[0]).toEqual(INPUT);
    expect(adapter.joinCalls[0]).not.toBe(INPUT);
  });

  it("calls onJoined exactly once, synchronously", async () => {
    const onJoined = vi.fn();
    const adapter = new FakePlatformAdapter({ onJoined });

    const pending = adapter.join(INPUT, createHandlers().handlers);

    expect(onJoined).toHaveBeenCalledTimes(1);
    await pending;
    expect(onJoined).toHaveBeenCalledTimes(1);
  });

  it("lets onJoined emit events to the handlers", async () => {
    const { handlers, events } = createHandlers();
    const adapter: FakePlatformAdapter = new FakePlatformAdapter({
      onJoined: () => adapter.emit({ type: "waiting" }),
    });

    await adapter.join(INPUT, handlers);

    expect(events).toEqual([{ type: "waiting" }]);
  });

  it("rejects with the same joinError instance and still records the call", async () => {
    const error = new PlatformLinkUnusableError("bad link");
    const onJoined = vi.fn();
    const adapter = new FakePlatformAdapter({ joinError: error, onJoined });

    const caught = await adapter.join(INPUT, createHandlers().handlers).catch((e: unknown) => e);

    expect(caught).toBe(error);
    expect(caught).toBeInstanceOf(PlatformLinkUnusableError);
    expect(caught).toBeInstanceOf(Error);
    expect(adapter.joinCalls).toEqual([INPUT]);
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("rejects with a plain joinError that is not a link-unusable error", async () => {
    const error = new Error("network down");
    const adapter = new FakePlatformAdapter({ joinError: error });

    const caught = await adapter.join(INPUT, createHandlers().handlers).catch((e: unknown) => e);

    expect(caught).toBe(error);
    expect(caught).not.toBeInstanceOf(PlatformLinkUnusableError);
  });

  it("keeps emit and emitAudio unusable after a failed join, while leave still resolves", async () => {
    const adapter = new FakePlatformAdapter({ joinError: new Error("nope") });
    await adapter.join(INPUT, createHandlers().handlers).catch(() => undefined);

    expect(() => adapter.emit({ type: "admitted" })).toThrow();
    expect(() => adapter.emitAudio(createSilenceFrame(20))).toThrow();
    await expect(adapter.leave()).resolves.toBeUndefined();
  });

  it("rejects a second join while joined, records it and keeps the first handlers", async () => {
    const { adapter, events } = await joinedAdapter();
    const second = createHandlers();

    await expect(adapter.join(INPUT, second.handlers)).rejects.toThrow(
      "FakePlatformAdapter: join called twice"
    );

    expect(adapter.joinCalls).toHaveLength(2);
    adapter.emit({ type: "admitted" });
    expect(events).toEqual([{ type: "admitted" }]);
    expect(second.events).toEqual([]);
  });

  it("rejects a join after leave and records it", async () => {
    const adapter = new FakePlatformAdapter();
    await adapter.leave();

    await expect(adapter.join(INPUT, createHandlers().handlers)).rejects.toThrow(
      "FakePlatformAdapter: join called after leave"
    );

    expect(adapter.joinCalls).toHaveLength(1);
  });

  it("returns a rejected promise instead of throwing synchronously", async () => {
    const adapter = new FakePlatformAdapter({ joinError: new Error("nope") });
    let result: Promise<void> | undefined;

    expect(() => {
      result = adapter.join(INPUT, createHandlers().handlers);
      result.catch(() => undefined);
    }).not.toThrow();

    await expect(result).rejects.toThrow("nope");
  });
});

describe("emit and emitAudio", () => {
  it("throws from emit before join", () => {
    const adapter = new FakePlatformAdapter();

    expect(() => adapter.emit({ type: "waiting" })).toThrow(/join/);
  });

  it("throws from emitAudio before join", () => {
    const adapter = new FakePlatformAdapter();

    expect(() => adapter.emitAudio(createSilenceFrame(20))).toThrow(/join/);
  });

  it("delivers every event variant in order as the same objects", async () => {
    const { adapter, events } = await joinedAdapter();

    for (const event of ALL_EVENTS) adapter.emit(event);

    expect(events).toHaveLength(ALL_EVENTS.length);
    ALL_EVENTS.forEach((event, index) => {
      expect(events[index]).toBe(event);
    });
  });

  it("passes the same frame reference to onAudioFrame and nothing to onEvent", async () => {
    const { adapter, events, frames } = await joinedAdapter();
    const frame = createSilenceFrame(20);

    adapter.emitAudio(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(frame);
    expect(events).toEqual([]);
  });

  it("does not keep audio on the adapter", async () => {
    const { adapter } = await joinedAdapter();
    const frame = createSilenceFrame(20);

    adapter.emitAudio(frame);

    const values = Object.values(adapter);
    expect(values).not.toContain(frame);
    expect(values).not.toContain(frame.samples);
    for (const value of values) {
      if (Array.isArray(value)) {
        expect(value).not.toContain(frame);
        expect(value).not.toContain(frame.samples);
      }
    }
  });

  it("throws right after leave is called, even while a delayed leave is pending", async () => {
    const { adapter } = await joinedAdapter({ leaveDelayMs: 5000 });

    const leaving = adapter.leave();

    expect(() => adapter.emit({ type: "meeting_ended" })).toThrow(/leave/);
    expect(() => adapter.emitAudio(createSilenceFrame(20))).toThrow(/leave/);
    await vi.advanceTimersByTimeAsync(5000);
    await leaving;
  });

  it("propagates the same error when a handler throws", async () => {
    const error = new Error("handler boom");
    const adapter = new FakePlatformAdapter();
    await adapter.join(INPUT, {
      onEvent: () => {
        throw error;
      },
      onAudioFrame: () => undefined,
    });

    let caught: unknown;
    try {
      adapter.emit({ type: "waiting" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(error);
  });
});

describe("postChatMessage", () => {
  it("records texts in call order and resolves", async () => {
    const { adapter } = await joinedAdapter();

    await expect(adapter.postChatMessage("first")).resolves.toBeUndefined();
    await adapter.postChatMessage("second");

    expect(adapter.chatMessages).toEqual(["first", "second"]);
  });

  it("rejects with the postChatError instance and records nothing", async () => {
    const error = new Error("chat closed");
    const { adapter } = await joinedAdapter({ postChatError: error });

    const caught = await adapter.postChatMessage("hello").catch((e: unknown) => e);

    expect(caught).toBe(error);
    expect(adapter.chatMessages).toEqual([]);
  });

  it("clears the constructor error with setPostChatError(null)", async () => {
    const { adapter } = await joinedAdapter({ postChatError: new Error("chat closed") });

    adapter.setPostChatError(null);

    await expect(adapter.postChatMessage("hello")).resolves.toBeUndefined();
    expect(adapter.chatMessages).toEqual(["hello"]);
  });

  it("applies a later setPostChatError to subsequent calls only", async () => {
    const { adapter } = await joinedAdapter();
    await adapter.postChatMessage("before");
    const error = new Error("chat closed");

    adapter.setPostChatError(error);

    await expect(adapter.postChatMessage("after")).rejects.toBe(error);
    expect(adapter.chatMessages).toEqual(["before"]);
  });

  it("rejects before join and records nothing", async () => {
    const adapter = new FakePlatformAdapter();

    await expect(adapter.postChatMessage("hello")).rejects.toThrow(
      "FakePlatformAdapter: postChatMessage called while not in a meeting"
    );

    expect(adapter.chatMessages).toEqual([]);
  });

  it("rejects after leave and records nothing", async () => {
    const { adapter } = await joinedAdapter();
    await adapter.leave();

    await expect(adapter.postChatMessage("hello")).rejects.toThrow(
      "FakePlatformAdapter: postChatMessage called while not in a meeting"
    );

    expect(adapter.chatMessages).toEqual([]);
  });

  it("can be spied on and the spy counts a rejected attempt", async () => {
    const adapter = new FakePlatformAdapter();
    const spy = vi.spyOn(adapter, "postChatMessage");

    await adapter.postChatMessage("hello").catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello");
  });
});

describe("reconnect", () => {
  it("resolves true at once by default and counts the call", async () => {
    const { adapter } = await joinedAdapter();

    const state = track(adapter.reconnect());
    await Promise.resolve();

    expect(state.settled).toBe(true);
    expect(state.value).toBe(true);
    expect(adapter.reconnectCalls).toBe(1);
  });

  it("resolves false when reconnectResult is false", async () => {
    const { adapter } = await joinedAdapter({ reconnectResult: false });

    await expect(adapter.reconnect()).resolves.toBe(false);
  });

  it("waits for reconnectDelayMs and counts the call immediately", async () => {
    const { adapter } = await joinedAdapter({ reconnectDelayMs: 1000 });

    const state = track(adapter.reconnect());

    expect(adapter.reconnectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.value).toBe(true);
  });

  it("resolves false after the delay when reconnectResult is false", async () => {
    const { adapter } = await joinedAdapter({ reconnectDelayMs: 1000, reconnectResult: false });

    const state = track(adapter.reconnect());
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.settled).toBe(true);
    expect(state.value).toBe(false);
  });

  it("counts every call", async () => {
    const { adapter } = await joinedAdapter();

    await adapter.reconnect();
    await adapter.reconnect();
    await adapter.reconnect();

    expect(adapter.reconnectCalls).toBe(3);
  });

  it("resolves false before join and still counts", async () => {
    const adapter = new FakePlatformAdapter();

    await expect(adapter.reconnect()).resolves.toBe(false);

    expect(adapter.reconnectCalls).toBe(1);
  });

  it("resolves false after leave and still counts", async () => {
    const { adapter } = await joinedAdapter();
    await adapter.leave();

    await expect(adapter.reconnect()).resolves.toBe(false);

    expect(adapter.reconnectCalls).toBe(1);
  });

  it("settles a pending delayed reconnect as false when leave is called, leaving no timer", async () => {
    const { adapter } = await joinedAdapter({ reconnectDelayMs: 1000 });
    const pending = adapter.reconnect();
    expect(vi.getTimerCount()).toBe(1);

    await adapter.leave();

    await expect(pending).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits nothing", async () => {
    const { adapter, events, frames } = await joinedAdapter();

    await expect(adapter.reconnect()).resolves.toBe(true);

    expect(events).toEqual([]);
    expect(frames).toEqual([]);
  });
});

describe("leave", () => {
  it("resolves at once by default and counts the call", async () => {
    const { adapter } = await joinedAdapter();

    const state = track(adapter.leave());
    await Promise.resolve();

    expect(state.settled).toBe(true);
    expect(adapter.leaveCalls).toBe(1);
  });

  it("waits for leaveDelayMs and counts the call immediately", async () => {
    const { adapter } = await joinedAdapter({ leaveDelayMs: 5000 });

    const state = track(adapter.leave());

    expect(adapter.leaveCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
  });

  it("is idempotent with a delay: one timer, both promises resolve together", async () => {
    const { adapter } = await joinedAdapter({ leaveDelayMs: 5000 });

    const first = track(adapter.leave());
    await vi.advanceTimersByTimeAsync(1000);
    const second = track(adapter.leave());

    expect(adapter.leaveCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
  });

  it("resolves at once after completion and still counts", async () => {
    const { adapter } = await joinedAdapter({ leaveDelayMs: 5000 });
    const first = adapter.leave();
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    const state = track(adapter.leave());
    await Promise.resolve();

    expect(state.settled).toBe(true);
    expect(adapter.leaveCalls).toBe(2);
  });

  it("resolves before join and counts", async () => {
    const adapter = new FakePlatformAdapter();

    await expect(adapter.leave()).resolves.toBeUndefined();

    expect(adapter.leaveCalls).toBe(1);
  });

  it("creates no timer when no delay is configured", async () => {
    const adapter = new FakePlatformAdapter();

    await adapter.join(INPUT, createHandlers().handlers);
    expect(vi.getTimerCount()).toBe(0);
    await adapter.reconnect();
    expect(vi.getTimerCount()).toBe(0);
    await adapter.leave();
    expect(vi.getTimerCount()).toBe(0);
  });
});
