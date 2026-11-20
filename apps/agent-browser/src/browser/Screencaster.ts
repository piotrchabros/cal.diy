import { AGENT_BROWSER_VIEWPORT } from "@calcom/lib/agentBrowser/contract";
import type { Page } from "playwright";
import type { Logger } from "../logger";

type ScreencastFrame = { data: string; sessionId: number };

// The slice of a CDP session the screencaster needs, so tests can drive it without a browser.
interface ScreencastTransport {
  start(options: { quality: number; maxWidth: number; maxHeight: number }): Promise<void>;
  acknowledge(sessionId: number): Promise<void>;
  onFrame(listener: (frame: ScreencastFrame) => void): void;
  close(): Promise<void>;
}

type ScreencasterDeps<TTarget> = {
  open: (target: TTarget) => Promise<ScreencastTransport>;
  fps: number;
  quality: number;
  onFrame: (jpeg: Buffer) => void;
  now?: () => number;
  logger: Logger;
};

const noop = (): void => {};

class Screencaster<TTarget> {
  private readonly deps: ScreencasterDeps<TTarget>;
  private readonly now: () => number;
  private readonly minFrameIntervalMs: number;
  private transport: ScreencastTransport | null = null;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: ScreencasterDeps<TTarget>) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.minFrameIntervalMs = 1000 / deps.fps;
  }

  retarget(target: TTarget): Promise<void> {
    return this.enqueue(async () => {
      await this.closeTransport();
      if (this.stopped) return;
      await this.openTransport(target);
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    return this.enqueue(() => this.closeTransport());
  }

  private async openTransport(target: TTarget): Promise<void> {
    let transport: ScreencastTransport | null = null;
    try {
      transport = await this.deps.open(target);
      const opened = transport;
      opened.onFrame((frame) => this.handleFrame(opened, frame));
      this.transport = opened;
      await opened.start({
        quality: this.deps.quality,
        maxWidth: AGENT_BROWSER_VIEWPORT.width,
        maxHeight: AGENT_BROWSER_VIEWPORT.height,
      });
    } catch (error) {
      // Viewers then keep the last frame; the actions themselves still work, so the session is not failed.
      this.deps.logger.warn("screencast could not start", {
        error: error instanceof Error ? error.name : "unknown",
      });
      if (transport && this.transport === transport) this.transport = null;
      await transport?.close().catch(noop);
    }
  }

  private handleFrame(transport: ScreencastTransport, frame: ScreencastFrame): void {
    // Chromium sends the next frame only after the previous one is acknowledged, so every frame is acked,
    // including the ones dropped by the fps throttle and late frames from a transport being replaced.
    transport.acknowledge(frame.sessionId).catch(noop);
    if (this.stopped || transport !== this.transport) return;

    const now = this.now();
    if (now - this.lastFrameAt < this.minFrameIntervalMs) return;
    this.lastFrameAt = now;
    this.deps.onFrame(Buffer.from(frame.data, "base64"));
  }

  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    await transport?.close().catch(noop);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(noop);
    return run;
  }
}

async function openPageScreencastTransport(page: Page): Promise<ScreencastTransport> {
  const cdp = await page.context().newCDPSession(page);
  return {
    start: async ({ quality, maxWidth, maxHeight }) => {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame: 1,
      });
    },
    acknowledge: async (sessionId) => {
      await cdp.send("Page.screencastFrameAck", { sessionId });
    },
    onFrame: (listener) => {
      cdp.on("Page.screencastFrame", (frame) => listener({ data: frame.data, sessionId: frame.sessionId }));
    },
    close: async () => {
      await cdp.send("Page.stopScreencast").catch(noop);
      await cdp.detach().catch(noop);
    },
  };
}

export type { ScreencastFrame, ScreencastTransport };
export { openPageScreencastTransport, Screencaster };
