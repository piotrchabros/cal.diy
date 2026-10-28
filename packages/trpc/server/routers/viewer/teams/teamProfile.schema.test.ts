import { describe, expect, it } from "vitest";
import { ZTeamLogoUrlSchema } from "./teamProfile.schema";

describe("ZTeamLogoUrlSchema", () => {
  it("accepts a large PNG or JPEG data URL from the uploader", () => {
    const payload = "A".repeat(200_000);
    expect(ZTeamLogoUrlSchema.safeParse(`data:image/png;base64,${payload}`).success).toBe(true);
    expect(ZTeamLogoUrlSchema.safeParse(`data:image/jpeg;base64,${payload}`).success).toBe(true);
  });

  it("accepts an SVG data URL, a stored avatar path and an https URL", () => {
    expect(ZTeamLogoUrlSchema.safeParse("data:image/svg+xml;base64,PHN2Zz4=").success).toBe(true);
    expect(ZTeamLogoUrlSchema.safeParse("/api/avatar/0b6c1f5e-1d2a-4c43-9a51-2f7c3b1e9d10.png").success).toBe(
      true
    );
    expect(ZTeamLogoUrlSchema.safeParse("https://example.com/logo.png").success).toBe(true);
  });

  it("rejects other schemes and other data types", () => {
    expect(ZTeamLogoUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(ZTeamLogoUrlSchema.safeParse("data:text/html;base64,PGgxPg==").success).toBe(false);
    expect(ZTeamLogoUrlSchema.safeParse("/api/other/logo.png").success).toBe(false);
  });
});
