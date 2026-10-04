export const TEAM_LOGO_MAX_BYTES = 5 * 1024 * 1024;

export const TEAM_LOGO_ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif"];

export type TeamLogoFileError = "invalid-type" | "too-large";

type LogoFileLike = Pick<File, "type" | "size">;

export function validateTeamLogoFile(file: LogoFileLike): TeamLogoFileError | null {
  if (!TEAM_LOGO_ACCEPTED_TYPES.includes(file.type)) {
    return "invalid-type";
  }
  if (file.size > TEAM_LOGO_MAX_BYTES) {
    return "too-large";
  }
  return null;
}
