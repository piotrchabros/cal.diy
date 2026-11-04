import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMemberSharingTeamIds } from "../../service/RegularBookingService";

const { resolveMemberSharingTeamIds } = vi.hoisted(() => ({ resolveMemberSharingTeamIds: vi.fn() }));

vi.mock("@calcom/features/notetaker/lib/webhookSharingTeam", () => ({ resolveMemberSharingTeamIds }));

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn().mockResolvedValue((key: string) => key),
}));

vi.mock("@calcom/prisma", () => ({
  default: vi.fn(),
  prisma: {},
}));

const OWNER_ID = 7;
const TEAM_ID = 42;
const prismaClient = {} as Parameters<typeof getMemberSharingTeamIds>[0]["prismaClient"];

const personalEventType = {
  id: 11,
  teamId: null,
  userId: OWNER_ID,
  team: null,
  notetakerSettings: { sharingMode: "TEAM" as const, sharingTeam: { id: TEAM_ID, name: "Sales" } },
};

describe("getMemberSharingTeamIds", () => {
  let logger: { error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    logger = { error: vi.fn() };
  });

  it("returns the sharing team resolved from the event type and its notetaker settings", async () => {
    resolveMemberSharingTeamIds.mockResolvedValue([TEAM_ID]);

    const result = await getMemberSharingTeamIds({
      eventType: personalEventType,
      ownerUserId: OWNER_ID,
      prismaClient,
      logger,
    });

    expect(result).toEqual([TEAM_ID]);
    expect(resolveMemberSharingTeamIds).toHaveBeenCalledWith(
      {
        ownerUserId: OWNER_ID,
        eventType: {
          teamId: null,
          userId: OWNER_ID,
          team: null,
          notetakerSettings: personalEventType.notetakerSettings,
        },
        bookingMetadata: null,
      },
      expect.objectContaining({ isAcceptedMember: expect.any(Function) })
    );
  });

  it("passes only the team fields the resolver reads", async () => {
    resolveMemberSharingTeamIds.mockResolvedValue([TEAM_ID]);
    const team = { id: TEAM_ID, name: "Sales", parentId: null, hideBranding: true };

    await getMemberSharingTeamIds({
      eventType: { id: 12, teamId: TEAM_ID, userId: null, team },
      ownerUserId: OWNER_ID,
      prismaClient,
      logger,
    });

    expect(resolveMemberSharingTeamIds.mock.calls[0][0].eventType).toEqual({
      teamId: TEAM_ID,
      userId: null,
      team: { id: TEAM_ID, name: "Sales", parentId: null },
      notetakerSettings: null,
    });
  });

  it("returns no teams for a dynamic event without resolving", async () => {
    const result = await getMemberSharingTeamIds({
      eventType: { id: 0, teamId: null, userId: 0, team: null },
      ownerUserId: OWNER_ID,
      prismaClient,
      logger,
    });

    expect(result).toEqual([]);
    expect(resolveMemberSharingTeamIds).not.toHaveBeenCalled();
  });

  it("returns no teams and logs only ids when resolving fails", async () => {
    resolveMemberSharingTeamIds.mockRejectedValue(new Error("db down for owner@example.com"));

    const result = await getMemberSharingTeamIds({
      eventType: personalEventType,
      ownerUserId: OWNER_ID,
      prismaClient,
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.error.mock.calls[0]);
    expect(logged).toContain(String(personalEventType.id));
    expect(logged).not.toContain("owner@example.com");
  });
});
