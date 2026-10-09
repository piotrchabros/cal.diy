import type { Pcm16Frame } from "../audio/AudioFrame";
import { createSilenceFrame, getFrameDurationMs } from "../audio/AudioFrame";

type AudioFramePumpDeps = {
  sink: (frame: Pcm16Frame) => void;
  // The transcript clock, 0 at admission. An epoch clock would make the first gap enormous and ask for a huge silence frame.
  nowMs: () => number;
  maxGapMs?: number;
};

const DEFAULT_MAX_GAP_MS = 200;

// Pads gaps with silence so the speech-to-text provider's audio clock stays on the transcript clock.
export class AudioFramePump {
  private readonly sink: (frame: Pcm16Frame) => void;
  private readonly nowMs: () => number;
  private readonly maxGapMs: number;
  private started = false;
  private stopped = false;
  // Unrounded so per-frame rounding never accumulates into drift.
  private totalMs = 0;

  constructor(deps: AudioFramePumpDeps) {
    this.sink = deps.sink;
    this.nowMs = deps.nowMs;
    this.maxGapMs = deps.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  }

  get forwardedMs(): number {
    return Math.round(this.totalMs);
  }

  start(): void {
    if (this.stopped) return;
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  push(frame: Pcm16Frame): void {
    if (!this.started || this.stopped) return;
    if (frame.samples.length === 0) return;

    const gap = this.nowMs() - this.totalMs;
    if (Number.isFinite(gap) && gap > this.maxGapMs) {
      const silence = createSilenceFrame(gap);
      this.sink(silence);
      this.totalMs += getFrameDurationMs(silence);
    }

    this.sink(frame);
    this.totalMs += getFrameDurationMs(frame);
  }
}
