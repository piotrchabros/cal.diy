import { ZUpdateTeamProfileInputSchema as FeaturesZUpdateTeamProfileInputSchema } from "@calcom/features/teams/lib/teamProfileSchema";
import { describe, expect, it } from "vitest";
import { ZUpdateTeamProfileInputSchema } from "./teamProfile.schema";

describe("teamProfile.schema re-export", () => {
  it("re-exports the same schema object from features", () => {
    expect(ZUpdateTeamProfileInputSchema).toBe(FeaturesZUpdateTeamProfileInputSchema);
  });
});
