// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Pcm16Frame } from "../audio/AudioFrame";
import { AudioFramePump } from "./AudioFramePump";

type Seen = { length: number; silent: boolean };

const frame = (ms: number): Pcm16Frame => ({ samples: new Int16Array(ms * 16).fill(1) });

const setup = (options: { maxGapMs?: number } = {}) => {
  let now = 0;
  const seen: Seen[] = [];
  const frames: Pcm16Frame[] = [];
  const pump = new AudioFramePump({
    sink: (f) => {
      seen.push({ length: f.samples.length, silent: f.samples.every((s) => s === 0) });
      frames.push(f);
    },
    nowMs: () => now,
    ...options,
  });
  return {
    pump,
    seen,
    frames,
    setNow: (value: number) => {
      now = value;
    },
  };
};

describe("AudioFramePump", () => {
  it("drops a push before start", () => {
    const { pump, seen } = setup();

    pump.push(frame(128));

    expect(seen).toEqual([]);
    expect(pump.forwardedMs).toBe(0);
  });

  it("forwards the first frame as the same object with no silence", () => {
    const { pump, seen, frames } = setup();
    const first = frame(128);

    pump.start();
    pump.push(first);

    expect(seen).toHaveLength(1);
    expect(frames[0]).toBe(first);
    expect(pump.forwardedMs).toBe(128);
  });

  it("adds no silence for a gap of exactly 200 ms", () => {
    const { pump, seen, setNow } = setup();
    pump.start();
    setNow(200);

    pump.push(frame(128));

    expect(seen).toEqual([{ length: 2048, silent: false }]);
  });

  it("adds one silence frame for a gap of 201 ms before the frame", () => {
    const { pump, seen, setNow } = setup();
    pump.start();
    setNow(201);

    pump.push(frame(128));

    expect(seen).toEqual([
      { length: Math.round(201 * 16), silent: true },
      { length: 2048, silent: false },
    ]);
  });

  it("fills the leading gap when the first frame arrives late", () => {
    const { pump, seen, setNow } = setup();
    pump.start();
    setNow(1000);

    pump.push(frame(128));

    expect(seen).toEqual([
      { length: 16000, silent: true },
      { length: 2048, silent: false },
    ]);
    expect(pump.forwardedMs).toBe(1128);
  });

  it("adds no silence for a steady stream", () => {
    const { pump, seen, setNow } = setup();
    pump.start();

    for (let i = 0; i < 100; i++) {
      if (i > 0) setNow(i * 128);
      pump.push(frame(128));
    }

    expect(seen).toHaveLength(100);
    expect(seen.every((s) => !s.silent)).toBe(true);
    expect(pump.forwardedMs).toBe(12800);
  });

  it("reports an integer forwardedMs rounded from the unrounded total", () => {
    const { pump } = setup();
    pump.start();

    for (let i = 0; i < 8; i++) {
      pump.push({ samples: new Int16Array(1).fill(1) });
    }

    expect(pump.forwardedMs).toBe(1);
    expect(Number.isInteger(pump.forwardedMs)).toBe(true);

    const exact = setup();
    exact.pump.start();
    exact.pump.push({ samples: new Int16Array(2048).fill(1) });
    expect(exact.pump.forwardedMs).toBe(128);
    exact.pump.push({ samples: new Int16Array(2048).fill(1) });
    expect(exact.pump.forwardedMs).toBe(256);
  });

  it("forwards audio that is ahead of the clock without silence", () => {
    const { pump, seen } = setup();
    pump.start();

    pump.push(frame(128));
    pump.push(frame(128));
    pump.push(frame(128));

    expect(seen).toHaveLength(3);
    expect(seen.every((s) => !s.silent)).toBe(true);
    expect(pump.forwardedMs).toBe(384);
  });

  it("honours a custom maxGapMs", () => {
    const { pump, seen, setNow } = setup({ maxGapMs: 50 });
    pump.start();
    setNow(50);
    pump.push(frame(10));
    expect(seen).toEqual([{ length: 160, silent: false }]);

    setNow(10 + 51);
    pump.push(frame(10));

    expect(seen.slice(1)).toEqual([
      { length: Math.round(51 * 16), silent: true },
      { length: 160, silent: false },
    ]);
  });

  it("ignores pushes, a second stop and a restart after stop", () => {
    const { pump, seen, setNow } = setup();
    pump.start();
    pump.push(frame(128));

    pump.stop();
    setNow(5000);
    pump.push(frame(128));
    pump.stop();
    pump.start();
    pump.push(frame(128));

    expect(seen).toHaveLength(1);
    expect(pump.forwardedMs).toBe(128);
  });

  it("does not forward an empty frame", () => {
    const { pump, seen, setNow } = setup();
    pump.start();
    setNow(1000);

    pump.push({ samples: new Int16Array(0) });

    expect(seen).toEqual([]);
    expect(pump.forwardedMs).toBe(0);
  });

  it("propagates a sink error without advancing and recovers on the next push", () => {
    let fail = true;
    const received: number[] = [];
    const pump = new AudioFramePump({
      sink: (f) => {
        if (fail) throw new Error("sink down");
        received.push(f.samples.length);
      },
      nowMs: () => 0,
    });
    pump.start();

    expect(() => pump.push(frame(128))).toThrow("sink down");
    expect(pump.forwardedMs).toBe(0);

    fail = false;
    pump.push(frame(128));

    expect(received).toEqual([2048]);
    expect(pump.forwardedMs).toBe(128);
  });
});
