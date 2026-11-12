import { uploadAvatar } from "@calcom/lib/server/avatar";
import { resizeBase64Image } from "@calcom/lib/server/resizeBase64Image";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUploadUserAvatar } from "./uploadUserAvatar";

vi.mock("@calcom/lib/server/avatar", () => ({ uploadAvatar: vi.fn() }));
vi.mock("@calcom/lib/server/resizeBase64Image", () => ({ resizeBase64Image: vi.fn() }));

describe("defaultUploadUserAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resizes the image, uploads it for the user and returns the URL", async () => {
    vi.mocked(resizeBase64Image).mockResolvedValue("data:image/png;base64,resized");
    vi.mocked(uploadAvatar).mockResolvedValue("/api/avatar/abc.png");

    const url = await defaultUploadUserAvatar({ userId: 7, avatar: "data:image/png;base64,original" });

    expect(resizeBase64Image).toHaveBeenCalledWith("data:image/png;base64,original");
    expect(uploadAvatar).toHaveBeenCalledWith({ userId: 7, avatar: "data:image/png;base64,resized" });
    expect(url).toBe("/api/avatar/abc.png");
  });

  it("does not upload when resizing fails", async () => {
    vi.mocked(resizeBase64Image).mockRejectedValue(new Error("bad image"));

    await expect(defaultUploadUserAvatar({ userId: 7, avatar: "nope" })).rejects.toThrow("bad image");
    expect(uploadAvatar).not.toHaveBeenCalled();
  });
});
