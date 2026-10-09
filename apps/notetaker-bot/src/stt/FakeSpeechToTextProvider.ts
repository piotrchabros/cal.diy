import type { Pcm16Frame } from "../audio/AudioFrame";
import { getFrameDurationMs } from "../audio/AudioFrame";
import type { SpeechToTextProvider, SttHandlers, SttUtterance } from "./SpeechToTextProvider";

export class FakeSpeechToTextProvider implements SpeechToTextProvider {
  started = false;
  closed = false;
  receivedAudioMs = 0;

  private readonly startError: Error | undefined;
  private readonly utterancesOnClose: SttUtterance[];
  private readonly closeDelayMs: number;
  private handlers: SttHandlers | null = null;
  private released = false;
  private totalAudioMs = 0;
  private closePromise: Promise<void> | null = null;

  constructor(options?: { startError?: Error; utterancesOnClose?: SttUtterance[]; closeDelayMs?: number }) {
    this.startError = options?.startError;
    this.utterancesOnClose = options?.utterancesOnClose ?? [];
    this.closeDelayMs = options?.closeDelayMs ?? 0;
  }

  async start(handlers: SttHandlers): Promise<void> {
    if (this.startError) throw this.startError;
    this.handlers = handlers;
    this.started = true;
  }

  pushAudio(frame: Pcm16Frame): void {
    if (!this.started || this.closed) return;
    // The unrounded total is kept so per-frame rounding cannot drift over a long meeting.
    this.totalAudioMs += getFrameDurationMs(frame);
    this.receivedAudioMs = Math.round(this.totalAudioMs);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  // Both emitters drop silently instead of throwing: the fake meeting emits from timers, and a
  // stop before admission or after close would otherwise raise an uncaught exception inside a
  // timer in the runner process.
  emitUtterance(utterance: SttUtterance): void {
    if (!this.handlers || this.released) return;
    this.handlers.onUtterance(utterance);
  }

  emitError(error: Error): void {
    if (!this.handlers || this.released) return;
    this.handlers.onError(error);
  }

  private async finishClose(): Promise<void> {
    if (this.closeDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.closeDelayMs));
    }
    if (this.handlers) {
      for (const utterance of this.utterancesOnClose) {
        this.handlers.onUtterance(utterance);
      }
    }
    this.released = true;
  }
}
