import { describe, expect, it } from "vitest";
import { findCreatableTeamProfile, getNewEventTypeHref } from "./createEventTypeDialogUtils";

const personal = { teamId: null, slug: "alice", permissions: { canCreateEventType: true } };
const team = { teamId: 7, slug: "team/acme", permissions: { canCreateEventType: true } };
const readOnlyTeam = { teamId: 8, slug: "team/ro", permissions: { canCreateEventType: false } };

describe("findCreatableTeamProfile", () => {
  it("returns the option of the team when the user may create event types", () => {
    expect(findCreatableTeamProfile([personal, team], 7)).toBe(team);
  });

  it("returns undefined when teamId is missing", () => {
    expect(findCreatableTeamProfile([personal, team], null)).toBeUndefined();
    expect(findCreatableTeamProfile([personal, team], undefined)).toBeUndefined();
    expect(findCreatableTeamProfile([personal, team], 0)).toBeUndefined();
  });

  it("returns undefined when the team is not among the options", () => {
    expect(findCreatableTeamProfile([personal, team], 99)).toBeUndefined();
  });

  it("returns undefined when the user cannot create event types for the team", () => {
    expect(findCreatableTeamProfile([personal, readOnlyTeam], 8)).toBeUndefined();
  });

  it("returns undefined for empty options", () => {
    expect(findCreatableTeamProfile([], 7)).toBeUndefined();
  });
});

describe("getNewEventTypeHref", () => {
  it("targets the active team when it is creatable", () => {
    expect(getNewEventTypeHref({ profileOptions: [personal, team], activeTeamId: 7 })).toBe(
      "?dialog=new&eventPage=team/acme&teamId=7"
    );
  });

  it("targets the personal profile when there is no active team", () => {
    expect(getNewEventTypeHref({ profileOptions: [team, personal], activeTeamId: null })).toBe(
      "?dialog=new&eventPage=alice"
    );
  });

  it("falls back to the personal profile when the active team is not creatable", () => {
    expect(getNewEventTypeHref({ profileOptions: [personal, readOnlyTeam], activeTeamId: 8 })).toBe(
      "?dialog=new&eventPage=alice"
    );
  });

  it("falls back to the personal profile when the active team is unknown", () => {
    expect(getNewEventTypeHref({ profileOptions: [personal, team], activeTeamId: 99 })).toBe(
      "?dialog=new&eventPage=alice"
    );
  });

  it("uses the first option when none is personal", () => {
    expect(getNewEventTypeHref({ profileOptions: [team], activeTeamId: undefined })).toBe(
      "?dialog=new&eventPage=team/acme"
    );
  });

  it("uses an empty slug when the profile has none", () => {
    const noSlugPersonal = { teamId: undefined, slug: null, permissions: { canCreateEventType: true } };
    const noSlugTeam = { teamId: 7, slug: null, permissions: { canCreateEventType: true } };
    expect(getNewEventTypeHref({ profileOptions: [noSlugPersonal], activeTeamId: null })).toBe(
      "?dialog=new&eventPage="
    );
    expect(getNewEventTypeHref({ profileOptions: [noSlugTeam], activeTeamId: 7 })).toBe(
      "?dialog=new&eventPage=&teamId=7"
    );
  });

  it("returns a link with an empty slug for empty options", () => {
    expect(getNewEventTypeHref({ profileOptions: [], activeTeamId: null })).toBe("?dialog=new&eventPage=");
  });
});
