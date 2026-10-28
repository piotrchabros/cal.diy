import { uploadAvatar } from "@calcom/lib/server/avatar";
import { isBase64Image, resizeBase64Image } from "@calcom/lib/server/resizeBase64Image";

type AvatarStorage = {
  resize: (dataUrl: string) => Promise<string>;
  upload: (input: { userId: number; avatar: string }) => Promise<string>;
};

const defaultStorage: AvatarStorage = {
  resize: (dataUrl) => resizeBase64Image(dataUrl),
  upload: (input) => uploadAvatar(input),
};

export function isImageDataUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("data:image/");
}

// A base64 image left in users.avatarUrl is copied into the session cookie and into every page payload,
// which made sessions too large to send and logged people out in a loop.
export async function storeAdminUserAvatar(
  userId: number,
  dataUrl: string,
  storage: AvatarStorage = defaultStorage
): Promise<string> {
  // SVGs skip resizing: uploadAvatar rasterises them to PNG itself.
  const avatar = isBase64Image(dataUrl) ? await storage.resize(dataUrl) : dataUrl;
  return await storage.upload({ userId, avatar });
}
