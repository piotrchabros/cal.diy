import { describe, expect, it, vi } from "vitest";
import type { NotetakerEventTypeContext } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import type { NotetakerSharingSource } from "./sharingScope";
import {
  deriveNotetakerSharingTeam,
  resolveNotetakerSharingScope,
  toNotetakerSharingSource,
} from "./sharingScope";

const TEAM_ID = 20;
const ORGANIZATION_ID = 5;
const CHOSEN_TEAM_ID = 30;
const OWNER_ID = 1;

function source(overrides: Partial<NotetakerSharingSource> = {}): NotetakerSharingSource {
  return {
    teamId: TEAM_ID,
    teamName: "Sales",
    organizationId: null,
    sharingOwnerUserId: null,
    sharingMode: "TEAM",
    ...overrides,
  };
}

function eventTypeContext(overrides: Partial<NotetakerEventTypeContext> = {}): NotetakerEventTypeContext {
  return {
    id: 10,
    userId: null,
    teamId: null,
    locations: null,
    ownerName: null,
    title: "Intro",
    teamName: null,
    organizationId: null,
    effectiveSharingTeamId: null,
    effectiveSharingTeamName: null,
    sharingOwnerUserId: null,
    settings: null,
    ...overrides,
  };
}

function spiedLookup() {
  const lookup = new InMemoryNotetakerMembershipLookup();
  const isAcceptedMember = vi.spyOn(lookup, "isAcceptedMember");
  return { lookup, isAcceptedMember };
}

describe("deriveNotetakerSharingTeam", () => {
  it("gives the own team of a team event type, with its parent and no owner", () => {
    expect(
      deriveNotetakerSharingTeam({
        eventTypeTeam: { id: TEAM_ID, name: "Sales", parentId: ORGANIZATION_ID },
        eventTypeUserId: null,
        chosenTeam: null,
      })
    ).toEqual({
      teamId: TEAM_ID,
      teamName: "Sales",
      organizationId: ORGANIZATION_ID,
      sharingOwnerUserId: null,
    });
  });

  it("gives the chosen team of a personal event type, without an organization and with the owner", () => {
    expect(
      deriveNotetakerSharingTeam({
        eventTypeTeam: null,
        eventTypeUserId: OWNER_ID,
        chosenTeam: { id: CHOSEN_TEAM_ID, name: "Support" },
      })
    ).toEqual({
      teamId: CHOSEN_TEAM_ID,
      teamName: "Support",
      organizationId: null,
      sharingOwnerUserId: OWNER_ID,
    });
  });

  it("gives no team for a personal event type without a chosen team", () => {
    expect(
      deriveNotetakerSharingTeam({ eventTypeTeam: null, eventTypeUserId: OWNER_ID, chosenTeam: null })
    ).toEqual({ teamId: null, teamName: null, organizationId: null, sharingOwnerUserId: null });
  });

  it("lets the own team win over a stale chosen team", () => {
    expect(
      deriveNotetakerSharingTeam({
        eventTypeTeam: { id: TEAM_ID, name: "Sales", parentId: null },
        eventTypeUserId: OWNER_ID,
        chosenTeam: { id: CHOSEN_TEAM_ID, name: "Support" },
      })
    ).toEqual({ teamId: TEAM_ID, teamName: "Sales", organizationId: null, sharingOwnerUserId: null });
  });

  it("gives no team when a chosen team has no owner to vouch for it", () => {
    expect(
      deriveNotetakerSharingTeam({
        eventTypeTeam: null,
        eventTypeUserId: null,
        chosenTeam: { id: CHOSEN_TEAM_ID, name: "Support" },
      })
    ).toEqual({ teamId: null, teamName: null, organizationId: null, sharingOwnerUserId: null });
  });
});

describe("toNotetakerSharingSource", () => {
  it("maps a team event type to its own team and organization", () => {
    expect(
      toNotetakerSharingSource(
        eventTypeContext({
          teamId: TEAM_ID,
          teamName: "Sales",
          organizationId: ORGANIZATION_ID,
          effectiveSharingTeamId: TEAM_ID,
          effectiveSharingTeamName: "Sales",
          settings: {
            eventTypeId: 10,
            enabledByDefault: false,
            updatedAt: new Date("2026-10-01T00:00:00.000Z"),
            sharingMode: "SELECTED_PEOPLE",
            sharingSetByUserId: null,
            sharingSetAt: null,
            sharingTeamId: null,
          },
        })
      )
    ).toEqual({
      teamId: TEAM_ID,
      teamName: "Sales",
      organizationId: ORGANIZATION_ID,
      sharingOwnerUserId: null,
      sharingMode: "SELECTED_PEOPLE",
    });
  });

  it("maps a personal event type to the chosen team, without an organization", () => {
    expect(
      toNotetakerSharingSource(
        eventTypeContext({
          userId: OWNER_ID,
          effectiveSharingTeamId: CHOSEN_TEAM_ID,
          effectiveSharingTeamName: "Support",
          sharingOwnerUserId: OWNER_ID,
          settings: {
            eventTypeId: 10,
            enabledByDefault: false,
            updatedAt: new Date("2026-10-01T00:00:00.000Z"),
            sharingMode: "TEAM",
            sharingSetByUserId: OWNER_ID,
            sharingSetAt: null,
            sharingTeamId: CHOSEN_TEAM_ID,
          },
        })
      )
    ).toEqual({
      teamId: CHOSEN_TEAM_ID,
      teamName: "Support",
      organizationId: null,
      sharingOwnerUserId: OWNER_ID,
      sharingMode: "TEAM",
    });
  });

  it("reports HOSTS_ONLY and no team without a settings row", () => {
    expect(toNotetakerSharingSource(eventTypeContext({ userId: OWNER_ID }))).toEqual({
      teamId: null,
      teamName: null,
      organizationId: null,
      sharingOwnerUserId: null,
      sharingMode: "HOSTS_ONLY",
    });
  });
});

describe("resolveNotetakerSharingScope", () => {
  it("gives null for HOSTS_ONLY without a lookup", async () => {
    const { lookup, isAcceptedMember } = spiedLookup();

    const scope = await resolveNotetakerSharingScope(
      source({ sharingMode: "HOSTS_ONLY", sharingOwnerUserId: OWNER_ID }),
      lookup
    );

    expect(scope).toBeNull();
    expect(isAcceptedMember).not.toHaveBeenCalled();
  });

  it("gives null without a team, without a lookup", async () => {
    const { lookup, isAcceptedMember } = spiedLookup();

    const scope = await resolveNotetakerSharingScope(source({ teamId: null, teamName: null }), lookup);

    expect(scope).toBeNull();
    expect(isAcceptedMember).not.toHaveBeenCalled();
  });

  it("gives the scope of a team event type without a lookup", async () => {
    const { lookup, isAcceptedMember } = spiedLookup();

    const scope = await resolveNotetakerSharingScope(source(), lookup);

    expect(scope).toEqual({ mode: "TEAM", teamId: TEAM_ID, teamName: "Sales", eligibilityTeamId: TEAM_ID });
    expect(isAcceptedMember).not.toHaveBeenCalled();
  });

  it("checks eligibility in the organization of a team event type that has a parent", async () => {
    const { lookup } = spiedLookup();

    const scope = await resolveNotetakerSharingScope(
      source({ organizationId: ORGANIZATION_ID, sharingMode: "SELECTED_PEOPLE" }),
      lookup
    );

    expect(scope).toEqual({
      mode: "SELECTED_PEOPLE",
      teamId: TEAM_ID,
      teamName: "Sales",
      eligibilityTeamId: ORGANIZATION_ID,
    });
  });

  it("gives the scope of a personal event type while its owner is an accepted member", async () => {
    const { lookup, isAcceptedMember } = spiedLookup();
    lookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: OWNER_ID });

    const scope = await resolveNotetakerSharingScope(
      source({ teamId: CHOSEN_TEAM_ID, teamName: "Support", sharingOwnerUserId: OWNER_ID }),
      lookup
    );

    expect(scope).toEqual({
      mode: "TEAM",
      teamId: CHOSEN_TEAM_ID,
      teamName: "Support",
      eligibilityTeamId: CHOSEN_TEAM_ID,
    });
    expect(isAcceptedMember).toHaveBeenCalledTimes(1);
    expect(isAcceptedMember).toHaveBeenCalledWith({ userId: OWNER_ID, teamId: CHOSEN_TEAM_ID });
  });

  it("gives null when the owner's membership is not accepted", async () => {
    const { lookup } = spiedLookup();
    lookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: OWNER_ID, accepted: false });

    const scope = await resolveNotetakerSharingScope(
      source({ teamId: CHOSEN_TEAM_ID, teamName: "Support", sharingOwnerUserId: OWNER_ID }),
      lookup
    );

    expect(scope).toBeNull();
  });

  it("gives null when the owner is not a member of the chosen team", async () => {
    const { lookup } = spiedLookup();
    lookup.addMember({ teamId: TEAM_ID, userId: OWNER_ID });

    const scope = await resolveNotetakerSharingScope(
      source({
        teamId: CHOSEN_TEAM_ID,
        teamName: "Support",
        sharingOwnerUserId: OWNER_ID,
        sharingMode: "SELECTED_PEOPLE",
      }),
      lookup
    );

    expect(scope).toBeNull();
  });
});
