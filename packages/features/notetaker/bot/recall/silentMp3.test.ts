import { describe, expect, it } from "vitest";
import { buildSilentMp3, RECALL_SILENT_MP3_BASE64, SILENT_MP3_FRAME_BYTES } from "./silentMp3";

const MPEG1_LAYER3_BITRATES_KBPS: number[] = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG1_SAMPLE_RATES_HZ: number[] = [44100, 48000, 32000];

type ParsedFrameHeader = {
  sync: number;
  version: number;
  layer: number;
  noCrc: number;
  bitrateKbps: number;
  sampleRateHz: number;
  padding: number;
  channelMode: number;
  frameLength: number;
};

function parseFrameHeader(mp3: Buffer, offset: number): ParsedFrameHeader {
  const header = mp3.readUInt32BE(offset);
  const bitrateKbps = MPEG1_LAYER3_BITRATES_KBPS[(header >>> 12) & 0xf];
  const sampleRateHz = MPEG1_SAMPLE_RATES_HZ[(header >>> 10) & 0x3];
  const padding = (header >>> 9) & 0x1;
  return {
    sync: header >>> 21,
    version: (header >>> 19) & 0x3,
    layer: (header >>> 17) & 0x3,
    noCrc: (header >>> 16) & 0x1,
    bitrateKbps,
    sampleRateHz,
    padding,
    channelMode: (header >>> 6) & 0x3,
    frameLength: Math.floor((144 * bitrateKbps * 1000) / sampleRateHz) + padding,
  };
}

describe("buildSilentMp3", () => {
  it("returns 96 bytes per frame", () => {
    expect(SILENT_MP3_FRAME_BYTES).toBe(96);
    expect(buildSilentMp3(1)).toHaveLength(96);
    expect(buildSilentMp3(5)).toHaveLength(480);
    expect(buildSilentMp3(0)).toHaveLength(0);
  });

  it("starts every frame with an MPEG-1 Layer III 32 kbps 48 kHz mono header", () => {
    const mp3 = buildSilentMp3(3);
    for (let offset = 0; offset < mp3.length; offset += SILENT_MP3_FRAME_BYTES) {
      expect([...mp3.subarray(offset, offset + 4)]).toEqual([0xff, 0xfb, 0x14, 0xc0]);
      expect(parseFrameHeader(mp3, offset)).toEqual({
        sync: 0x7ff,
        version: 0b11,
        layer: 0b01,
        noCrc: 1,
        bitrateKbps: 32,
        sampleRateHz: 48000,
        padding: 0,
        channelMode: 0b11,
        frameLength: SILENT_MP3_FRAME_BYTES,
      });
    }
  });

  it("zeroes everything after each frame header", () => {
    const mp3 = buildSilentMp3(3);
    for (let offset = 0; offset < mp3.length; offset += SILENT_MP3_FRAME_BYTES) {
      const payload = mp3.subarray(offset + 4, offset + SILENT_MP3_FRAME_BYTES);
      expect(payload.every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe("RECALL_SILENT_MP3_BASE64", () => {
  it("decodes to 42 silent frames", () => {
    const mp3 = Buffer.from(RECALL_SILENT_MP3_BASE64, "base64");
    expect(mp3).toHaveLength(4032);
    expect(mp3.subarray(0, 4).toString("hex")).toBe("fffb14c0");
    expect(mp3.equals(buildSilentMp3(42))).toBe(true);
  });
});
