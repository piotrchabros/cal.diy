import { uploadAvatar } from "@calcom/lib/server/avatar";
import { resizeBase64Image } from "@calcom/lib/server/resizeBase64Image";

export type UploadUserAvatar = (input: { userId: number; avatar: string }) => Promise<string>;

export const defaultUploadUserAvatar: UploadUserAvatar = async ({ userId, avatar }) =>
  uploadAvatar({ userId, avatar: await resizeBase64Image(avatar) });
