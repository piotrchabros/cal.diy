import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodeJpegCover } from "./imageUtils";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const solidImage = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 0.5 } } });

const noiseImage = (width: number, height: number) => {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(Math.random() * 256);
  return sharp(pixels, { raw: { width, height, channels: 3 } });
};

describe("encodeJpegCover", () => {
  it.each([
    ["PNG", () => solidImage(400, 400).png().toBuffer()],
    ["WEBP", () => solidImage(2000, 500).webp().toBuffer()],
    ["JPEG", () => solidImage(300, 900).jpeg().toBuffer()],
  ])("crops a %s input into a 1280x720 JPEG under the size limit", async (_, makeInput) => {
    const maxBytes = 950_000;

    const output = await encodeJpegCover({ buffer: await makeInput(), width: 1280, height: 720, maxBytes });

    expect([...output.subarray(0, 3)]).toEqual(JPEG_MAGIC);
    expect(output.length).toBeLessThanOrEqual(maxBytes);
    const meta = await sharp(output).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 1280, height: 720 });
    expect(meta.hasAlpha).toBe(false);
  });

  it("lowers the quality until the output fits", async () => {
    const buffer = await noiseImage(1280, 720).png().toBuffer();
    const atTopQuality = await encodeJpegCover({ buffer, width: 1280, height: 720, maxBytes: 10_000_000 });

    const output = await encodeJpegCover({
      buffer,
      width: 1280,
      height: 720,
      maxBytes: atTopQuality.length - 1,
    });

    expect(output.length).toBeLessThan(atTopQuality.length);
  });

  it("rejects an image that cannot fit even at the lowest quality", async () => {
    const buffer = await noiseImage(1280, 720).png().toBuffer();

    await expect(
      encodeJpegCover({ buffer, width: 1280, height: 720, maxBytes: 1_000 })
    ).rejects.toMatchObject({ message: "notetaker_bot_image_too_large" });
  });

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')],
    ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary")],
    ["unknown bytes", Buffer.from("not an image")],
  ])("rejects %s input", async (_, buffer) => {
    await expect(
      encodeJpegCover({ buffer, width: 1280, height: 720, maxBytes: 950_000 })
    ).rejects.toMatchObject({ message: "notetaker_bot_image_invalid" });
  });

  it("rejects a corrupt PNG", async () => {
    const png = await solidImage(100, 100).png().toBuffer();

    await expect(
      encodeJpegCover({ buffer: png.subarray(0, 40), width: 1280, height: 720, maxBytes: 950_000 })
    ).rejects.toMatchObject({ message: "notetaker_bot_image_invalid" });
  });
});
