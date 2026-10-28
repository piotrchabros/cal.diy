import { describe, expect, it, vi } from "vitest";
import { isImageDataUrl, storeAdminUserAvatar } from "./adminUserAvatar";

const makeStorage = () => ({
  resize: vi.fn(async (dataUrl: string) => `resized:${dataUrl}`),
  upload: vi.fn(async ({ userId }: { userId: number; avatar: string }) => `/api/avatar/key-${userId}.png`),
});

describe("isImageDataUrl", () => {
  it("detects image data URLs only", () => {
    expect(isImageDataUrl("data:image/png;base64,iVBOR")).toBe(true);
    expect(isImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(true);
    expect(isImageDataUrl("/api/avatar/abc.png")).toBe(false);
    expect(isImageDataUrl("https://example.com/a.png")).toBe(false);
    expect(isImageDataUrl(null)).toBe(false);
    expect(isImageDataUrl(undefined)).toBe(false);
  });
});

describe("storeAdminUserAvatar", () => {
  it("resizes a PNG or JPEG avatar and stores it, returning the short avatar URL", async () => {
    const storage = makeStorage();

    const url = await storeAdminUserAvatar(59, "data:image/png;base64,iVBOR", storage);

    expect(url).toBe("/api/avatar/key-59.png");
    expect(storage.resize).toHaveBeenCalledWith("data:image/png;base64,iVBOR");
    expect(storage.upload).toHaveBeenCalledWith({
      userId: 59,
      avatar: "resized:data:image/png;base64,iVBOR",
    });
  });

  it("stores an SVG avatar without resizing it", async () => {
    const storage = makeStorage();

    await storeAdminUserAvatar(7, "data:image/svg+xml;base64,PHN2Zz4=", storage);

    expect(storage.resize).not.toHaveBeenCalled();
    expect(storage.upload).toHaveBeenCalledWith({ userId: 7, avatar: "data:image/svg+xml;base64,PHN2Zz4=" });
  });
});
