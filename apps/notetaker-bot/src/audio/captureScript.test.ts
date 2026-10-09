// @vitest-environment node
import { Buffer } from "node:buffer";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_FRAME_BINDING,
  type AudioCaptureOptions,
  buildAudioCaptureInitScript,
  DEFAULT_AUDIO_CAPTURE_OPTIONS,
  decodeAudioFramePayload,
  decodeSourceActivityPayload,
  installAudioCapture,
  SOURCE_ACTIVITY_BINDING,
} from "./captureScript";

type Listener = (event: unknown) => void;
type SourceEntry = { source: number; timestamp: number; audioLevel?: unknown };

class StubNode {
  readonly connect = vi.fn<(target: unknown) => void>();
  readonly disconnect = vi.fn<() => void>();
}

class StubProcessor extends StubNode {
  onaudioprocess: ((event: unknown) => void) | null = null;
  constructor(readonly args: unknown[]) {
    super();
  }
}

class StubSource extends StubNode {
  constructor(readonly stream: StubMediaStream) {
    super();
  }
}

class StubMediaStream {
  constructor(readonly tracks: unknown[]) {}
}

type StubTrack = {
  kind: string;
  id: string;
  addEventListener: (type: string, listener: Listener) => void;
  emit: (type: string) => void;
};

type StubReceiver = {
  getContributingSources: () => SourceEntry[];
  getSynchronizationSources: () => SourceEntry[];
  csrc: SourceEntry[];
  ssrc: SourceEntry[];
};

function isConstructor(value: unknown): value is new () => unknown {
  return typeof value === "function";
}

function createHarness(options?: {
  withBindings?: boolean;
  contextState?: string;
  scriptOptions?: AudioCaptureOptions;
}) {
  const withBindings = options?.withBindings ?? true;

  class StubPeerConnection {
    static instances: StubPeerConnection[] = [];
    readonly listeners = new Map<string, Listener[]>();
    constructor() {
      StubPeerConnection.instances.push(this);
    }
    addEventListener(type: string, listener: Listener): void {
      const existing = this.listeners.get(type) ?? [];
      existing.push(listener);
      this.listeners.set(type, existing);
    }
    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  const contexts: StubAudioContext[] = [];

  class StubAudioContext {
    state = options?.contextState ?? "running";
    readonly destination = { name: "destination" };
    readonly gains: StubNode[] = [];
    readonly processors: StubProcessor[] = [];
    readonly sources: StubSource[] = [];
    readonly resume = vi.fn<() => void>();
    constructor(readonly options: unknown) {
      contexts.push(this);
    }
    createGain(): StubNode {
      const node = new StubNode();
      this.gains.push(node);
      return node;
    }
    createScriptProcessor(...args: unknown[]): StubProcessor {
      const node = new StubProcessor(args);
      this.processors.push(node);
      return node;
    }
    createMediaStreamSource(stream: StubMediaStream): StubSource {
      const node = new StubSource(stream);
      this.sources.push(node);
      return node;
    }
  }

  const intervals: { callback: () => void; ms: unknown }[] = [];
  const frameBinding = vi.fn<(payload: unknown) => void>();
  const activityBinding = vi.fn<(payload: unknown) => void>();

  const sandbox: Record<string, unknown> = {
    RTCPeerConnection: StubPeerConnection,
    AudioContext: StubAudioContext,
    MediaStream: StubMediaStream,
    btoa: (binary: string) => Buffer.from(binary, "latin1").toString("base64"),
    setInterval: (callback: () => void, ms: unknown) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
  };
  if (withBindings) {
    sandbox[AUDIO_FRAME_BINDING] = frameBinding;
    sandbox[SOURCE_ACTIVITY_BINDING] = activityBinding;
  }

  const context = vm.createContext(sandbox);
  const script = buildAudioCaptureInitScript(options?.scriptOptions);
  vm.runInContext(script, context);

  function createConnection(): StubPeerConnection {
    const Wrapped = sandbox.RTCPeerConnection;
    if (!isConstructor(Wrapped)) throw new Error("RTCPeerConnection was removed from the sandbox");
    const instance = new Wrapped();
    if (!(instance instanceof StubPeerConnection)) throw new Error("not an instance of the stub class");
    return instance;
  }

  function createTrack(kind: string, id: string): StubTrack {
    const listeners = new Map<string, Listener[]>();
    return {
      kind,
      id,
      addEventListener: (type: string, listener: Listener): void => {
        const existing = listeners.get(type) ?? [];
        existing.push(listener);
        listeners.set(type, existing);
      },
      emit: (type: string): void => {
        for (const listener of listeners.get(type) ?? []) listener({});
      },
    };
  }

  function createReceiver(csrc: SourceEntry[] = [], ssrc: SourceEntry[] = []): StubReceiver {
    const receiver: StubReceiver = {
      csrc,
      ssrc,
      getContributingSources: () => receiver.csrc,
      getSynchronizationSources: () => receiver.ssrc,
    };
    return receiver;
  }

  function addTrack(
    connection: StubPeerConnection,
    track: StubTrack,
    receiver: StubReceiver = createReceiver()
  ): void {
    connection.emit("track", { track, receiver, streams: [] });
  }

  function runProcessor(samples: Float32Array): void {
    const processor = contexts[0]?.processors[0];
    if (!processor?.onaudioprocess) throw new Error("no onaudioprocess handler");
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  }

  function tick(): void {
    const interval = intervals[0];
    if (!interval) throw new Error("no interval registered");
    interval.callback();
  }

  return {
    StubPeerConnection,
    sandbox,
    context,
    script,
    contexts,
    intervals,
    frameBinding,
    activityBinding,
    createConnection,
    createTrack,
    createReceiver,
    addTrack,
    runProcessor,
    tick,
  };
}

function wrap(functionSource: string, options: AudioCaptureOptions): string {
  return `(() => { const __name = (target) => target; (${functionSource})(${JSON.stringify(options)}); })();`;
}

function readSamples(buffer: Buffer): number[] {
  const samples: number[] = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) samples.push(buffer.readInt16LE(offset));
  return samples;
}

describe("captureScript constants", () => {
  it("pins the binding names and default options", () => {
    expect(AUDIO_FRAME_BINDING).toBe("__notetakerAudioFrame");
    expect(SOURCE_ACTIVITY_BINDING).toBe("__notetakerSourceActivity");
    expect(DEFAULT_AUDIO_CAPTURE_OPTIONS).toEqual({
      frameBinding: "__notetakerAudioFrame",
      activityBinding: "__notetakerSourceActivity",
      sampleRate: 16000,
      bufferSamples: 2048,
      activityIntervalMs: 250,
    });
  });
});

describe("buildAudioCaptureInitScript", () => {
  it("wraps the stringified function with the name shim and the custom options", () => {
    const custom: AudioCaptureOptions = {
      frameBinding: "frameX",
      activityBinding: "activityX",
      sampleRate: 8000,
      bufferSamples: 4096,
      activityIntervalMs: 100,
    };
    expect(buildAudioCaptureInitScript(custom)).toBe(wrap(installAudioCapture.toString(), custom));
  });

  it("uses the defaults when called without arguments", () => {
    expect(buildAudioCaptureInitScript()).toBe(
      wrap(installAudioCapture.toString(), DEFAULT_AUDIO_CAPTURE_OPTIONS)
    );
  });

  it("evaluates in a context holding only the stubs", () => {
    expect(() => createHarness()).not.toThrow();
  });

  it("covers the transpiler name helper with the shim", () => {
    const sandbox: Record<string, unknown> = {};
    const source = 'function () { const inner = function () {}; __name(inner, "x"); globalThis.ran = true; }';
    vm.runInContext(wrap(source, DEFAULT_AUDIO_CAPTURE_OPTIONS), vm.createContext(sandbox));
    expect(sandbox.ran).toBe(true);
  });

  it("does not contain recording, storage or network APIs", () => {
    const script = buildAudioCaptureInitScript();
    expect(script).not.toMatch(
      /MediaRecorder|Blob|createObjectURL|download|localStorage|indexedDB|XMLHttpRequest|WebSocket|fetch\(/
    );
  });
});

describe("installAudioCapture in a page", () => {
  it("wraps RTCPeerConnection, keeps instanceof and listens for tracks", () => {
    const harness = createHarness();
    expect(harness.sandbox.RTCPeerConnection).not.toBe(harness.StubPeerConnection);

    const connection = harness.createConnection();
    expect(connection).toBeInstanceOf(harness.StubPeerConnection);
    expect(connection.listeners.get("track")?.length).toBe(1);

    const fromPage = vm.runInContext("new RTCPeerConnection()", harness.context);
    expect(fromPage).toBeInstanceOf(harness.StubPeerConnection);
    if (!(fromPage instanceof harness.StubPeerConnection)) throw new Error("unreachable");
    expect(fromPage.listeners.get("track")?.length).toBe(1);
  });

  it("returns at once when RTCPeerConnection is not a function", () => {
    const sandbox: Record<string, unknown> = {};
    expect(() => vm.runInContext(buildAudioCaptureInitScript(), vm.createContext(sandbox))).not.toThrow();
    expect(sandbox.RTCPeerConnection).toBeUndefined();
  });

  it("creates no audio context before a track arrives", () => {
    const harness = createHarness();
    harness.createConnection();
    expect(harness.contexts).toHaveLength(0);
  });

  it("builds the audio graph lazily on the first audio track", () => {
    const harness = createHarness();
    const track = harness.createTrack("audio", "t1");
    harness.addTrack(harness.createConnection(), track);

    expect(harness.contexts).toHaveLength(1);
    const context = harness.contexts[0];
    if (!context) throw new Error("no context");
    expect(context.options).toEqual({ sampleRate: 16000 });
    expect(context.processors).toHaveLength(1);
    expect(context.processors[0]?.args).toEqual([2048, 1, 1]);
    expect(context.gains).toHaveLength(1);
    expect(context.sources).toHaveLength(1);
    expect(context.resume).not.toHaveBeenCalled();

    const source = context.sources[0];
    const mixer = context.gains[0];
    const processor = context.processors[0];
    expect(source?.stream.tracks).toEqual([track]);
    expect(source?.stream.tracks[0]).toBe(track);
    expect(source?.connect.mock.calls[0]?.[0]).toBe(mixer);
    expect(mixer?.connect.mock.calls[0]?.[0]).toBe(processor);
    expect(processor?.connect.mock.calls[0]?.[0]).toBe(context.destination);
  });

  it("resumes a suspended context only", () => {
    const suspended = createHarness({ contextState: "suspended" });
    suspended.addTrack(suspended.createConnection(), suspended.createTrack("audio", "s1"));
    expect(suspended.contexts[0]?.resume).toHaveBeenCalledTimes(1);
  });

  it("shares one context and processor across connections and dedupes track ids", () => {
    const harness = createHarness();
    const first = harness.createConnection();
    const second = harness.createConnection();
    harness.addTrack(first, harness.createTrack("audio", "a"));
    harness.addTrack(second, harness.createTrack("audio", "b"));
    harness.addTrack(second, harness.createTrack("audio", "b"));

    expect(harness.contexts).toHaveLength(1);
    expect(harness.contexts[0]?.processors).toHaveLength(1);
    expect(harness.contexts[0]?.sources).toHaveLength(2);
  });

  it("ignores video tracks", () => {
    const harness = createHarness();
    harness.addTrack(harness.createConnection(), harness.createTrack("video", "v1"));
    expect(harness.contexts).toHaveLength(0);
  });

  it("publishes processed audio as base64 little-endian PCM16", () => {
    const harness = createHarness();
    harness.addTrack(harness.createConnection(), harness.createTrack("audio", "t1"));
    harness.runProcessor(Float32Array.of(0, 0.5, -0.5, 1, -1, 2, -2, Number.NaN));

    expect(harness.frameBinding).toHaveBeenCalledTimes(1);
    const payload: unknown = harness.frameBinding.mock.calls[0]?.[0];
    expect(typeof payload).toBe("string");
    if (typeof payload !== "string") throw new Error("payload is not a string");
    expect(payload).toBe("AAAAQADA/38AgP9/AIAAAA==");

    const expected = [0, 16384, -16384, 32767, -32768, 32767, -32768, 0];
    expect(readSamples(Buffer.from(payload, "base64"))).toEqual(expected);
    expect(Array.from(decodeAudioFramePayload(payload)?.samples ?? [])).toEqual(expected);
  });

  it("registers one interval with the configured period", () => {
    const harness = createHarness();
    expect(harness.intervals).toHaveLength(1);
    expect(harness.intervals[0]?.ms).toBe(250);
  });

  it("reports fresh contributing and synchronization sources on a tick", () => {
    const harness = createHarness();
    const receiver = harness.createReceiver(
      [
        { source: 7, timestamp: Date.now(), audioLevel: 0.5 },
        { source: 8, timestamp: Date.now() - 10_000, audioLevel: 1 },
      ],
      [{ source: 9, timestamp: Date.now(), audioLevel: 0.2 }]
    );
    harness.addTrack(harness.createConnection(), harness.createTrack("audio", "t1"), receiver);
    harness.tick();

    expect(harness.activityBinding).toHaveBeenCalledTimes(1);
    const payload: unknown = harness.activityBinding.mock.calls[0]?.[0];
    const expected = [
      { sourceKey: "csrc:7", level: 0.5 },
      { sourceKey: "ssrc:9", level: 0.2 },
    ];
    expect(payload).toEqual(expected);
    expect(decodeSourceActivityPayload(payload)).toEqual(expected);
  });

  it("keeps the maximum level per source key", () => {
    const harness = createHarness();
    const receiver = harness.createReceiver([
      { source: 7, timestamp: Date.now(), audioLevel: 0.2 },
      { source: 7, timestamp: Date.now(), audioLevel: 0.6 },
    ]);
    harness.addTrack(harness.createConnection(), harness.createTrack("audio", "t1"), receiver);
    harness.tick();

    expect(harness.activityBinding.mock.calls[0]?.[0]).toEqual([{ sourceKey: "csrc:7", level: 0.6 }]);
  });

  it("does not report when there is nothing to report", () => {
    const noReceivers = createHarness();
    noReceivers.tick();
    expect(noReceivers.activityBinding).not.toHaveBeenCalled();

    const stale = createHarness();
    stale.addTrack(
      stale.createConnection(),
      stale.createTrack("audio", "t1"),
      stale.createReceiver(
        [{ source: 7, timestamp: Date.now() - 10_000, audioLevel: 0.5 }],
        [{ source: 9, timestamp: Date.now() - 10_000, audioLevel: 0.5 }]
      )
    );
    stale.tick();
    expect(stale.activityBinding).not.toHaveBeenCalled();

    const noLevel = createHarness();
    noLevel.addTrack(
      noLevel.createConnection(),
      noLevel.createTrack("audio", "t1"),
      noLevel.createReceiver([{ source: 7, timestamp: Date.now() }], [{ source: 9, timestamp: Date.now() }])
    );
    noLevel.tick();
    expect(noLevel.activityBinding).not.toHaveBeenCalled();
  });

  it("disconnects an ended track and stops reporting its receiver", () => {
    const harness = createHarness();
    const track = harness.createTrack("audio", "t1");
    const receiver = harness.createReceiver([{ source: 7, timestamp: Date.now(), audioLevel: 0.5 }]);
    harness.addTrack(harness.createConnection(), track, receiver);

    track.emit("ended");
    expect(harness.contexts[0]?.sources[0]?.disconnect).toHaveBeenCalledTimes(1);

    harness.tick();
    expect(harness.activityBinding).not.toHaveBeenCalled();
  });

  it("ignores missing bindings silently", () => {
    const harness = createHarness({ withBindings: false });
    harness.addTrack(
      harness.createConnection(),
      harness.createTrack("audio", "t1"),
      harness.createReceiver([{ source: 7, timestamp: Date.now(), audioLevel: 0.5 }])
    );
    expect(() => harness.runProcessor(Float32Array.of(0.1, -0.1))).not.toThrow();
    expect(() => harness.tick()).not.toThrow();
  });
});

describe("decodeAudioFramePayload", () => {
  it("rejects malformed payloads", () => {
    const overCap = "AAAA".repeat(65_537);
    for (const payload of [123, null, {}, "", "AA==", "AA*A", "AAAA\n", "AAA", overCap]) {
      expect(decodeAudioFramePayload(payload)).toBeNull();
    }
  });

  it("decodes little-endian PCM16", () => {
    const bytes = Buffer.alloc(6);
    bytes.writeInt16LE(1, 0);
    bytes.writeInt16LE(-2, 2);
    bytes.writeInt16LE(300, 4);
    const frame = decodeAudioFramePayload(bytes.toString("base64"));
    expect(frame).not.toBeNull();
    expect(frame?.samples).toEqual(Int16Array.of(1, -2, 300));
  });
});

describe("decodeSourceActivityPayload", () => {
  it("rejects malformed payloads", () => {
    const tooMany = Array.from({ length: 65 }, () => ({ sourceKey: "csrc:1", level: 0.5 }));
    const rejected: unknown[] = [
      "text",
      {},
      [null],
      [{ level: 0.5 }],
      [{ sourceKey: "abc:1", level: 0.5 }],
      [{ sourceKey: "csrc:x", level: 0.5 }],
      [{ sourceKey: "csrc:1", level: "0.5" }],
      [{ sourceKey: "csrc:1", level: Number.NaN }],
      [{ sourceKey: "csrc:1", level: -0.1 }],
      [{ sourceKey: "csrc:1", level: 1.1 }],
      tooMany,
    ];
    for (const payload of rejected) expect(decodeSourceActivityPayload(payload)).toBeNull();
  });

  it("accepts an empty array and strips extra properties", () => {
    expect(decodeSourceActivityPayload([])).toEqual([]);

    const input = { sourceKey: "ssrc:42", level: 1, extra: "x" };
    const result = decodeSourceActivityPayload([input]);
    expect(result).toEqual([{ sourceKey: "ssrc:42", level: 1 }]);
    expect(Object.keys(result?.[0] ?? {})).toEqual(["sourceKey", "level"]);
    expect(result?.[0]).not.toBe(input);
  });
});
