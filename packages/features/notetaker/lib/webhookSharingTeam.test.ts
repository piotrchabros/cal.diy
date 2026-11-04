import { describe, expect, it } from "vitest";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import { buildAdHocBookingMetadata, NOTETAKER_AD_HOC_SHARING_TEAM_KEY } from "./adHocMeeting";
import { NOTETAKER_CALENDAR_MEETING_KEY } from "./calendarMeeting";
import type { MemberSharingTeamInput } from "./webhookSharingTeam";
import { isTranscriptSharedWithTeam, resolveMemberSharingTeamIds } from "./webhookSharingTeam";

const OWNER_ID = 1;
const TEAM_ID = 20;
const ORGANIZATION_ID = 5;
const CHOSEN_TEAM_ID = 30;

type EventTypeInput = NonNullable<MemberSharingTeamInput["eventType"]>;

function teamEventType(overrides: Partial<EventTypeInput> = {}): EventTypeInput {
  return {
    teamId: TEAM_ID,
    userId: null,
    team: { id: TEAM_ID, name: "Sales", parentId: null },
    notetakerSettings: { sharingMode: "TEAM", sharingTeam: null },
    ...overrides,
  };
}

function personalEventType(overrides: Partial<EventTypeInput> = {}): EventTypeInput {
  return {
    teamId: null,
    userId: OWNER_ID,
    team: null,
    notetakerSettings: { sharingMode: "TEAM", sharingTeam: { id: CHOSEN_TEAM_ID, name: "Support" } },
    ...overrides,
  };
}

function lookupWithMembers(...teamIds: number[]): InMemoryNotetakerMembershipLookup {
  const lookup = new InMemoryNotetakerMembershipLookup();
  for (const teamId of teamIds) lookup.addMember({ teamId, userId: OWNER_ID });
  return lookup;
}

function resolve(
  input: Partial<MemberSharingTeamInput>,
  lookup: InMemoryNotetakerMembershipLookup
): Promise<number[]> {
  return resolveMemberSharingTeamIds(
    { ownerUserId: OWNER_ID, eventType: null, bookingMetadata: null, ...input },
    lookup
  );
}

describe("resolveMemberSharingTeamIds", () => {
  it("gives the own team of a team event type shared with the team", async () => {
    expect(await resolve({ eventType: teamEventType() }, lookupWithMembers(TEAM_ID))).toEqual([TEAM_ID]);
  });

  it("gives nothing for a team event type whose owner is not an accepted member of the team", async () => {
    const lookup = new InMemoryNotetakerMembershipLookup();
    lookup.addMember({ teamId: TEAM_ID, userId: OWNER_ID, accepted: false });
    expect(await resolve({ eventType: teamEventType() }, lookup)).toEqual([]);
  });

  it("gives the sub-team, never its organization, for a team event type of an organization team", async () => {
    const eventType = teamEventType({ team: { id: TEAM_ID, name: "Sales", parentId: ORGANIZATION_ID } });
    expect(await resolve({ eventType }, lookupWithMembers(TEAM_ID, ORGANIZATION_ID))).toEqual([TEAM_ID]);
    expect(await resolve({ eventType }, lookupWithMembers(ORGANIZATION_ID))).toEqual([]);
  });

  it("gives the chosen team of a personal event type shared with the team", async () => {
    expect(await resolve({ eventType: personalEventType() }, lookupWithMembers(CHOSEN_TEAM_ID))).toEqual([
      CHOSEN_TEAM_ID,
    ]);
  });

  it("gives nothing for a personal event type kept to hosts only", async () => {
    const eventType = personalEventType({
      notetakerSettings: { sharingMode: "HOSTS_ONLY", sharingTeam: { id: CHOSEN_TEAM_ID, name: "Support" } },
    });
    expect(await resolve({ eventType }, lookupWithMembers(CHOSEN_TEAM_ID))).toEqual([]);
  });

  it("gives nothing for an event type without notetaker settings", async () => {
    const eventType = teamEventType({ notetakerSettings: null });
    expect(await resolve({ eventType }, lookupWithMembers(TEAM_ID))).toEqual([]);
  });

  it("gives nothing when the results are shared with selected people", async () => {
    const lookup = lookupWithMembers(TEAM_ID, CHOSEN_TEAM_ID);
    const teamSelected = teamEventType({
      notetakerSettings: { sharingMode: "SELECTED_PEOPLE", sharingTeam: null },
    });
    const personalSelected = personalEventType({
      notetakerSettings: {
        sharingMode: "SELECTED_PEOPLE",
        sharingTeam: { id: CHOSEN_TEAM_ID, name: "Support" },
      },
    });
    expect(await resolve({ eventType: teamSelected }, lookup)).toEqual([]);
    expect(await resolve({ eventType: personalSelected }, lookup)).toEqual([]);
  });

  it("gives the sharing team stored in the metadata of an ad-hoc booking", async () => {
    const bookingMetadata = buildAdHocBookingMetadata({ sharingTeamId: CHOSEN_TEAM_ID });
    expect(await resolve({ bookingMetadata }, lookupWithMembers(CHOSEN_TEAM_ID))).toEqual([CHOSEN_TEAM_ID]);
  });

  it("gives nothing for an ad-hoc booking without a sharing team", async () => {
    const bookingMetadata = buildAdHocBookingMetadata({ sharingTeamId: null });
    expect(await resolve({ bookingMetadata }, lookupWithMembers(CHOSEN_TEAM_ID))).toEqual([]);
  });

  it("gives the sharing team stored in the metadata of an auto-joined calendar meeting", async () => {
    const bookingMetadata = {
      [NOTETAKER_CALENDAR_MEETING_KEY]: "true",
      [NOTETAKER_AD_HOC_SHARING_TEAM_KEY]: String(CHOSEN_TEAM_ID),
    };
    expect(await resolve({ bookingMetadata }, lookupWithMembers(CHOSEN_TEAM_ID))).toEqual([CHOSEN_TEAM_ID]);
  });

  it("ignores a sharing team in the metadata of a booking that has an event type", async () => {
    const bookingMetadata = buildAdHocBookingMetadata({ sharingTeamId: CHOSEN_TEAM_ID });
    const eventType = personalEventType({ notetakerSettings: null });
    expect(await resolve({ eventType, bookingMetadata }, lookupWithMembers(CHOSEN_TEAM_ID))).toEqual([]);
  });

  it("gives nothing once the owner is no longer a member of the sharing team", async () => {
    const lookup = lookupWithMembers(TEAM_ID, CHOSEN_TEAM_ID);
    lookup.removeMember({ teamId: TEAM_ID, userId: OWNER_ID });
    lookup.removeMember({ teamId: CHOSEN_TEAM_ID, userId: OWNER_ID });
    const bookingMetadata = buildAdHocBookingMetadata({ sharingTeamId: CHOSEN_TEAM_ID });
    expect(await resolve({ eventType: teamEventType() }, lookup)).toEqual([]);
    expect(await resolve({ eventType: personalEventType() }, lookup)).toEqual([]);
    expect(await resolve({ bookingMetadata }, lookup)).toEqual([]);
  });

  it("gives nothing for a booking without an owner", async () => {
    const lookup = lookupWithMembers(TEAM_ID, CHOSEN_TEAM_ID);
    const bookingMetadata = buildAdHocBookingMetadata({ sharingTeamId: CHOSEN_TEAM_ID });
    expect(await resolve({ ownerUserId: null, eventType: teamEventType() }, lookup)).toEqual([]);
    expect(await resolve({ ownerUserId: null, eventType: personalEventType() }, lookup)).toEqual([]);
    expect(await resolve({ ownerUserId: null, bookingMetadata }, lookup)).toEqual([]);
  });
});

describe("isTranscriptSharedWithTeam", () => {
  it("is true only for a disclosed session whose results are not deleted", () => {
    expect(isTranscriptSharedWithTeam({ colleagueSharingDisclosed: true, resultsDeletedAt: null })).toBe(
      true
    );
    expect(isTranscriptSharedWithTeam({ colleagueSharingDisclosed: false, resultsDeletedAt: null })).toBe(
      false
    );
    expect(
      isTranscriptSharedWithTeam({ colleagueSharingDisclosed: true, resultsDeletedAt: new Date() })
    ).toBe(false);
    expect(isTranscriptSharedWithTeam(null)).toBe(false);
  });
});
