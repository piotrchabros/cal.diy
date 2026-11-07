import { getPlaceholderAvatar } from "@calcom/lib/defaultAvatarImage";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toInstallTargetTeam } from "./installTargetTeam";

const parent = { id: 1, name: "BlueBee", logoUrl: "https://example.com/bluebee.png" };
const team = { id: 2, name: "Sales", logoUrl: "https://example.com/sales.png", isOrganization: false };

describe("toInstallTargetTeam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("drops the parent and uses the team logo when organizations are disabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    expect(toInstallTargetTeam({ ...team, parent })).toEqual({
      ...team,
      parent: null,
      logoUrl: getPlaceholderAvatar(team.logoUrl, team.name),
    });
  });

  test("keeps the parent and uses its logo when organizations are enabled", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    expect(toInstallTargetTeam({ ...team, parent })).toEqual({
      ...team,
      parent,
      logoUrl: getPlaceholderAvatar(parent.logoUrl, parent.name),
    });
  });

  test.each([
    "",
    "1",
  ])("uses the team logo for a team without a parent (ORGANIZATIONS_ENABLED=%j)", (flag) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", flag);

    expect(toInstallTargetTeam({ ...team, logoUrl: null, parent: null })).toEqual({
      ...team,
      parent: null,
      logoUrl: getPlaceholderAvatar(null, team.name),
    });
  });
});
