import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamInviteService } from "./TeamInviteService";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-10T12:00:00.000Z");

const makeTeamRepo = (existing: { token: string; expires: Date } | null = null) => ({
  findTeamInviteTokenByEmail: vi.fn().mockResolvedValue(existing),
  deleteTeamInviteTokens: vi.fn().mockResolvedValue(undefined),
  createTeamInviteToken: vi.fn().mockResolvedValue(undefined),
});

const inviteInput = {
  teamId: 7,
  teamName: "BlueBee",
  email: "ada@example.com",
  inviterName: "Owner",
  locale: "pl",
  isExistingUser: true,
};

describe("TeamInviteService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses a still-valid token", async () => {
    const teamRepository = makeTeamRepo({ token: "valid-token", expires: new Date(NOW.getTime() + DAY_MS) });
    const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
    const service = new TeamInviteService({ teamRepository: teamRepository as never, sendInviteEmail });

    await service.sendInvite(inviteInput);

    expect(teamRepository.deleteTeamInviteTokens).not.toHaveBeenCalled();
    expect(teamRepository.createTeamInviteToken).not.toHaveBeenCalled();
    expect(sendInviteEmail).toHaveBeenCalledWith({
      teamId: inviteInput.teamId,
      to: "ada@example.com",
      teamName: "BlueBee",
      joinLink: `${WEBAPP_URL}/auth/team-invite?token=valid-token`,
      logoHref: WEBAPP_URL,
      isExistingUser: true,
      inviterName: "Owner",
      locale: "pl",
    });
  });

  it("deletes an expired token and creates a new one valid for 7 days", async () => {
    const teamRepository = makeTeamRepo({ token: "stale-token", expires: new Date(NOW.getTime() - DAY_MS) });
    const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
    const service = new TeamInviteService({ teamRepository: teamRepository as never, sendInviteEmail });

    await service.sendInvite(inviteInput);

    expect(teamRepository.deleteTeamInviteTokens).toHaveBeenCalledWith({
      teamId: 7,
      email: "ada@example.com",
    });
    expect(teamRepository.createTeamInviteToken).toHaveBeenCalledTimes(1);
    const created = teamRepository.createTeamInviteToken.mock.calls[0][0];
    expect(created).toMatchObject({ teamId: 7, email: "ada@example.com" });
    expect(created.token).not.toBe("stale-token");
    expect(created.expires).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
    expect(sendInviteEmail.mock.calls[0][0].joinLink).toBe(
      `${WEBAPP_URL}/auth/team-invite?token=${created.token}`
    );
  });

  it("creates a token without deleting when none exists", async () => {
    const teamRepository = makeTeamRepo(null);
    const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
    const service = new TeamInviteService({ teamRepository: teamRepository as never, sendInviteEmail });

    await service.sendInvite(inviteInput);

    expect(teamRepository.deleteTeamInviteTokens).not.toHaveBeenCalled();
    expect(teamRepository.createTeamInviteToken).toHaveBeenCalledTimes(1);
  });

  it("forwards isOrganization to the email sender when set", async () => {
    const teamRepository = makeTeamRepo({ token: "valid-token", expires: new Date(NOW.getTime() + DAY_MS) });
    const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
    const service = new TeamInviteService({ teamRepository: teamRepository as never, sendInviteEmail });

    await service.sendInvite({ ...inviteInput, isOrganization: true });

    expect(sendInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ isOrganization: true }));
  });

  it("builds the join link on the team's organization base URL", async () => {
    const teamRepository = makeTeamRepo({ token: "valid-token", expires: new Date(NOW.getTime() + DAY_MS) });
    const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
    const getBaseUrlForTeam = vi.fn().mockResolvedValue("https://org.example.com");
    const service = new TeamInviteService({
      teamRepository: teamRepository as never,
      sendInviteEmail,
      organizationUrlService: { getBaseUrlForTeam },
    });

    await service.sendInvite(inviteInput);

    expect(getBaseUrlForTeam).toHaveBeenCalledWith({ teamId: 7 });
    expect(sendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        joinLink: "https://org.example.com/auth/team-invite?token=valid-token",
        logoHref: "https://org.example.com",
      })
    );
  });
});
