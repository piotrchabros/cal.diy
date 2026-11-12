import { uploadLogo } from "@calcom/lib/server/avatar";
import { isBase64Image, resizeBase64Image } from "@calcom/lib/server/resizeBase64Image";

export type UploadTeamLogo = (input: { teamId: number; logo: string }) => Promise<string>;

export const defaultUploadTeamLogo: UploadTeamLogo = async ({ teamId, logo }) => {
  // SVGs skip resizing: uploadLogo rasterises them to PNG itself.
  const resized = isBase64Image(logo) ? await resizeBase64Image(logo) : logo;
  return await uploadLogo({ teamId, logo: resized });
};
