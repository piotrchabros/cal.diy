import type { Pcm16Frame } from "../audio/AudioFrame";

// Positions are integer milliseconds of audio pushed since start(), so they stay comparable
// with the recording's own timeline; endMs >= startMs always holds.
export type SttUtterance = {
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
  diarizationLabel: string | null;
};

// onError means the provider has stopped for good, so callers must not wait for further
// utterances or retry on the same instance.
export type SttHandlers = {
  onUtterance(utterance: SttUtterance): void;
  onError(error: Error): void;
};

export interface SpeechToTextProvider {
  start(handlers: SttHandlers): Promise<void>;
  // Never buffers beyond the socket's own send queue, so a slow service cannot grow memory
  // during a long meeting.
  pushAudio(frame: Pcm16Frame): void;
  // Emits what is pending as final utterances, then releases the connection. Idempotent, and
  // nothing is emitted after the returned promise has resolved, so callers can finalize safely.
  close(): Promise<void>;
}
