import { describe, expect, it } from "vitest";
import { TEAM_LOGO_MAX_BYTES, validateTeamLogoFile } from "./validateTeamLogoFile";

describe("validateTeamLogoFile", () => {
  it("accepts a PNG within the size limit", () => {
    expect(validateTeamLogoFile({ type: "image/png", size: 1024 })).toBeNull();
  });

  it("rejects unsupported file types", () => {
    expect(validateTeamLogoFile({ type: "image/svg+xml", size: 1024 })).toBe("invalid-type");
    expect(validateTeamLogoFile({ type: "application/pdf", size: 1024 })).toBe("invalid-type");
  });

  it("rejects files larger than 5MB", () => {
    expect(validateTeamLogoFile({ type: "image/jpeg", size: TEAM_LOGO_MAX_BYTES + 1 })).toBe("too-large");
  });

  it("accepts a file exactly at the size limit", () => {
    expect(validateTeamLogoFile({ type: "image/gif", size: TEAM_LOGO_MAX_BYTES })).toBeNull();
  });
});
