export const AUDIO_SAMPLE_RATE_HZ = 16000;

export type Pcm16Frame = { samples: Int16Array };

// Left unrounded on purpose: callers round only when publishing a position, so rounding per frame would drift over a long meeting.
export function getFrameDurationMs(frame: Pcm16Frame): number {
  return (frame.samples.length * 1000) / AUDIO_SAMPLE_RATE_HZ;
}

export function createSilenceFrame(durationMs: number): Pcm16Frame {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { samples: new Int16Array(0) };
  }

  const sampleCount = Math.round((durationMs * AUDIO_SAMPLE_RATE_HZ) / 1000);
  return { samples: new Int16Array(sampleCount) };
}
