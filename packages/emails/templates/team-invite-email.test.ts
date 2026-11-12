import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { TeamInvite } from "../lib/utils/team-invite-utils";
import TeamInviteEmail from "./team-invite-email";

const buildInvite = (overrides: Partial<TeamInvite> = {}): TeamInvite => ({
  language: ((key: string) => key) as unknown as TFunction,
  from: "Owner",
  to: "ada@example.com",
  teamName: "BlueBee",
  joinLink: "https://example.com/join",
  isCalcomMember: true,
  isAutoJoin: false,
  isOrg: true,
  parentTeamName: undefined,
  isExistingUserMovedToOrg: false,
  prevLink: null,
  newLink: null,
  ...overrides,
});

const scopeOf = (email: TeamInviteEmail) =>
  (email as unknown as { getSenderScope(): unknown }).getSenderScope();

describe("TeamInviteEmail sender scope", () => {
  it("scopes the sender to the inviting team", () => {
    expect(scopeOf(new TeamInviteEmail(buildInvite({ senderTeamId: 7 })))).toEqual({ teamId: 7 });
  });

  it("has no scope without senderTeamId", () => {
    expect(scopeOf(new TeamInviteEmail(buildInvite()))).toBeNull();
  });
});
