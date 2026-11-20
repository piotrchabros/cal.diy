import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../logger";
import type { ScreencastFrame, ScreencastTransport } from "./Screencaster";
import { Screencaster } from "./Screencaster";

class FakeTransport implements ScreencastTransport {
  readonly acked: number[] = [];
  started: { quality: number; maxWidth: number; maxHeight: number } | null = null;
  closed = false;
  private listener: ((frame: ScreencastFrame) => void) | null = null;

  async start(options: { quality: number; maxWidth: number; maxHeight: number }): Promise<void> {
    this.started = options;
  }

  async acknowledge(sessionId: number): Promise<void> {
    this.acked.push(sessionId);
  }

  onFrame(listener: (frame: ScreencastFrame) => void): void {
    this.listener = listener;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(sessionId: number, text = `frame-${sessionId}`): void {
    this.listener?.({ data: Buffer.from(text).toString("base64"), sessionId });
  }
}

function setup(options: { fps?: number; failOpen?: boolean } = {}) {
  const transports = new Map<string, FakeTransport>();
  const frames: string[] = [];
  const clock = { now: 0 };
  const screencaster = new Screencaster<string>({
    open: async (target) => {
      if (options.failOpen) throw new Error("no cdp");
      const transport = new FakeTransport();
      transports.set(target, transport);
      return transport;
    },
    fps: options.fps ?? 10,
    quality: 70,
    onFrame: (jpeg) => frames.push(jpeg.toString()),
    now: () => clock.now,
    logger: createSilentLogger(),
  });
  return { screencaster, transports, frames, clock };
}

describe("Screencaster", () => {
  it("starts a JPEG screencast sized to the shared viewport", async () => {
    const { screencaster, transports } = setup();
    await screencaster.retarget("page-1");

    expect(transports.get("page-1")?.started).toEqual({ quality: 70, maxWidth: 1280, maxHeight: 680 });
  });

  it("acknowledges every frame and decodes the JPEG", async () => {
    const { screencaster, transports, frames, clock } = setup();
    await screencaster.retarget("page-1");
    const transport = transports.get("page-1");

    transport?.emit(1);
    clock.now = 100;
    transport?.emit(2);

    expect(transport?.acked).toEqual([1, 2]);
    expect(frames).toEqual(["frame-1", "frame-2"]);
  });

  it("drops frames above the fps limit but still acknowledges them", async () => {
    const { screencaster, transports, frames, clock } = setup({ fps: 10 });
    await screencaster.retarget("page-1");
    const transport = transports.get("page-1");

    transport?.emit(1);
    clock.now = 50;
    transport?.emit(2);
    clock.now = 99;
    transport?.emit(3);
    clock.now = 100;
    transport?.emit(4);

    expect(transport?.acked).toEqual([1, 2, 3, 4]);
    expect(frames).toEqual(["frame-1", "frame-4"]);
  });

  it("retarget closes the old transport and ignores its late frames", async () => {
    const { screencaster, transports, frames, clock } = setup();
    await screencaster.retarget("page-1");
    await screencaster.retarget("page-2");
    const old = transports.get("page-1");
    const current = transports.get("page-2");

    expect(old?.closed).toBe(true);
    old?.emit(7);
    expect(old?.acked).toEqual([7]);
    expect(frames).toEqual([]);

    clock.now = 1000;
    current?.emit(8);
    expect(frames).toEqual(["frame-8"]);
  });

  it("stop closes the transport and nothing is emitted afterwards", async () => {
    const { screencaster, transports, frames } = setup();
    await screencaster.retarget("page-1");
    await screencaster.stop();
    const transport = transports.get("page-1");

    transport?.emit(1);
    expect(transport?.closed).toBe(true);
    expect(transport?.acked).toEqual([1]);
    expect(frames).toEqual([]);
  });

  it("does not reopen after stop", async () => {
    const { screencaster, transports } = setup();
    await screencaster.stop();
    await screencaster.retarget("page-1");

    expect(transports.size).toBe(0);
  });

  it("a transport that cannot open does not throw", async () => {
    const { screencaster } = setup({ failOpen: true });
    await expect(screencaster.retarget("page-1")).resolves.toBeUndefined();
  });
});
