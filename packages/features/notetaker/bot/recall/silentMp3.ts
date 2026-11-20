// MPEG-1 Layer III, no CRC, 32 kbps, 48 kHz, mono, no padding: 144 * 32000 / 48000 = 96 bytes per frame.
const SILENT_FRAME_HEADER: number[] = [0xff, 0xfb, 0x14, 0xc0];
export const SILENT_MP3_FRAME_BYTES = 96;

// Built in code instead of shipped as a binary asset because no encoder is available here; all-zero side info
// decodes to silence. Recall only unlocks Output Audio for a bot created with an automatic_audio_output clip.
export function buildSilentMp3(frameCount: number): Buffer {
  const mp3 = Buffer.alloc(SILENT_MP3_FRAME_BYTES * frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    mp3.set(SILENT_FRAME_HEADER, frame * SILENT_MP3_FRAME_BYTES);
  }
  return mp3;
}

// 42 frames of 1152 samples at 48 kHz is about 1.0 s.
export const RECALL_SILENT_MP3_BASE64: string = buildSilentMp3(42).toString("base64");
