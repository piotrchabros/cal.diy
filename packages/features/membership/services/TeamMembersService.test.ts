import { describe, expect, it, vi, beforeEach } from "vitest";

import { ErrorWithCode } from "@calcom/lib/errors";
import { MembershipRole } from "@calcom/prisma/enums";

import { TeamMembersService } from "./TeamMembersService";

const makeMembershipRepo = (overrides: Record<string, unknown> = {}) => ({
  findUniqueByUserIdAndTeamId: vi.fn(),
  findTeamMembers: vi.fn(),
  countTeamMembers: vi.fn(),
  createTeamMembership: vi.fn(),
  acceptTeamMembership: vi.fn(),
  updateTeamMembershipRole: vi.fn(),
  deleteTeamMembership: vi.fn(),
  countAcceptedOwnersByTeamId: vi.fn(),
  ...overrides,
});

const makeTeamRepo = (overrides: Record<string, unknown> = {}) => ({
  findBasicById: vi.fn(),
  createTeamInviteToken: vi.fn(),
  findTeamInviteTokenByEmail: vi.fn(),
  ...overrides,
});

const makeUserRepo = (overrides: Record<string, unknown> = {}) => ({
  findInviteeByEmail: vi.fn(),
  ...overrides,
});

const team = { id: 7, name: "BlueBee", slug: "bluebee", logoUrl: null, isOrganization: false };
const adminMembership = { id: 1, teamId: 7, userId: 9, role: MembershipRole.ADMIN, accepted: true };

describe("TeamMembersService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listMembers", () => {
    it("returns paginated members for an accepted member", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi.fn().mockResolvedValue(adminMembership),
        findTeamMembers: vi.fn().mockResolvedValue([]),
        countTeamMembers: vi.fn().mockResolvedValue(0),
      });
      const teamRepo = makeTeamRepo({ findBasicById: vi.fn().mockResolvedValue(team) });
      const service = new TeamMembersService(
        membershipRepo as never,
        teamRepo as never,
        makeUserRepo() as never,
        vi.fn()
      );

      const result = await service.listMembers({ teamId: 7, viewerId: 9, search: "ada", page: 1 });

      expect(result.total).toBe(0);
      expect(result.team).toEqual(team);
      expect(membershipRepo.findTeamMembers).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 7, search: "ada", skip: 0, take: 10 })
      );
    });

    it("forwards the accepted status filter to the repository", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi.fn().mockResolvedValue(adminMembership),
        findTeamMembers: vi.fn().mockResolvedValue([]),
        countTeamMembers: vi.fn().mockResolvedValue(0),
      });
      const teamRepo = makeTeamRepo({ findBasicById: vi.fn().mockResolvedValue(team) });
      const service = new TeamMembersService(
        membershipRepo as never,
        teamRepo as never,
        makeUserRepo() as never,
        vi.fn()
      );

      await service.listMembers({ teamId: 7, viewerId: 9, accepted: false, page: 1 });

      expect(membershipRepo.findTeamMembers).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 7, accepted: false, skip: 0, take: 10 })
      );
      expect(membershipRepo.countTeamMembers).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 7, accepted: false })
      );
    });

    it("rejects viewers without an accepted membership", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi.fn().mockResolvedValue(null),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      await expect(service.listMembers({ teamId: 7, viewerId: 42 })).rejects.toBeInstanceOf(
        ErrorWithCode
      );
    });
  });

  describe("inviteMember", () => {
    it("creates a pending membership and emails an existing user", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValueOnce(adminMembership)
          .mockResolvedValueOnce(null),
        createTeamMembership: vi.fn().mockResolvedValue({ id: 3, role: "MEMBER", accepted: false }),
      });
      const teamRepo = makeTeamRepo({ findBasicById: vi.fn().mockResolvedValue(team) });
      const userRepo = makeUserRepo({
        findInviteeByEmail: vi
          .fn()
          .mockResolvedValue({ id: 11, email: "ada@example.com", name: "Ada", locale: "en" }),
      });
      const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
      const service = new TeamMembersService(
        membershipRepo as never,
        teamRepo as never,
        userRepo as never,
        sendInviteEmail
      );

      const result = await service.inviteMember({
        teamId: 7,
        requesterId: 9,
        requesterName: "Owner",
        email: "Ada@Example.com",
        role: MembershipRole.MEMBER,
      });

      expect(result).toEqual({ status: "invited", email: "ada@example.com" });
      expect(membershipRepo.createTeamMembership).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 7, userId: 11, accepted: false })
      );
      expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    });

    it("creates an invite token for a brand-new email", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi.fn().mockResolvedValue(adminMembership),
      });
      const teamRepo = makeTeamRepo({
        findBasicById: vi.fn().mockResolvedValue(team),
        createTeamInviteToken: vi.fn().mockResolvedValue({ id: 1, token: "t", expires: new Date() }),
      });
      const userRepo = makeUserRepo({ findInviteeByEmail: vi.fn().mockResolvedValue(null) });
      const sendInviteEmail = vi.fn().mockResolvedValue(undefined);
      const service = new TeamMembersService(
        membershipRepo as never,
        teamRepo as never,
        userRepo as never,
        sendInviteEmail
      );

      const result = await service.inviteMember({
        teamId: 7,
        requesterId: 9,
        requesterName: "Owner",
        email: "new@example.com",
        role: MembershipRole.MEMBER,
      });

      expect(result.status).toBe("invited-new");
      expect(teamRepo.createTeamInviteToken).toHaveBeenCalledTimes(1);
      expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    });

    it("rejects invites from non-admin members", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValue({ ...adminMembership, role: MembershipRole.MEMBER }),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      await expect(
        service.inviteMember({
          teamId: 7,
          requesterId: 9,
          requesterName: "Member",
          email: "x@example.com",
          role: MembershipRole.MEMBER,
        })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });

    it("rejects inviting someone who is already a member", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValueOnce(adminMembership)
          .mockResolvedValueOnce({ accepted: true, role: MembershipRole.MEMBER }),
      });
      const teamRepo = makeTeamRepo({ findBasicById: vi.fn().mockResolvedValue(team) });
      const userRepo = makeUserRepo({
        findInviteeByEmail: vi.fn().mockResolvedValue({ id: 11, email: "a@x.com", locale: "en" }),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        teamRepo as never,
        userRepo as never,
        vi.fn()
      );

      await expect(
        service.inviteMember({
          teamId: 7,
          requesterId: 9,
          requesterName: "Owner",
          email: "a@x.com",
          role: MembershipRole.MEMBER,
        })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });
  });

  describe("updateMemberRole", () => {
    it("protects the last owner from demotion", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValueOnce(adminMembership)
          .mockResolvedValueOnce({ id: 5, role: MembershipRole.OWNER, accepted: true }),
        countAcceptedOwnersByTeamId: vi.fn().mockResolvedValue(1),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      await expect(
        service.updateMemberRole({ teamId: 7, requesterId: 9, userId: 5, role: MembershipRole.MEMBER })
      ).rejects.toBeInstanceOf(ErrorWithCode);
      expect(membershipRepo.updateTeamMembershipRole).not.toHaveBeenCalled();
    });
  });

  describe("removeMember", () => {
    it("removes a regular member", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValueOnce(adminMembership)
          .mockResolvedValueOnce({ id: 6, role: MembershipRole.MEMBER, accepted: true }),
        deleteTeamMembership: vi.fn().mockResolvedValue({ id: 6 }),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      const result = await service.removeMember({ teamId: 7, requesterId: 9, userId: 12 });

      expect(result).toEqual({ id: 6 });
    });

    it("protects the last owner from removal", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValueOnce({ ...adminMembership, role: MembershipRole.OWNER })
          .mockResolvedValueOnce({ id: 5, role: MembershipRole.OWNER, accepted: true }),
        countAcceptedOwnersByTeamId: vi.fn().mockResolvedValue(1),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      await expect(service.removeMember({ teamId: 7, requesterId: 9, userId: 5 })).rejects.toBeInstanceOf(
        ErrorWithCode
      );
    });
  });

  describe("acceptInvite", () => {
    it("accepts a pending invitation", async () => {
      const membershipRepo = makeMembershipRepo({
        findUniqueByUserIdAndTeamId: vi
          .fn()
          .mockResolvedValue({ id: 6, role: MembershipRole.MEMBER, accepted: false }),
        acceptTeamMembership: vi.fn().mockResolvedValue({ id: 6, role: "MEMBER", accepted: true }),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      const result = await service.acceptInvite({ teamId: 7, userId: 12 });

      expect(result).toEqual({ status: "accepted" });
    });
  });

  describe("listMyTeams", () => {
    it("returns accepted teams flattened with roles", async () => {
      const membershipRepo = makeMembershipRepo({
        findAcceptedTeamsByUserId: vi.fn().mockResolvedValue([
          { role: MembershipRole.OWNER, team: { id: 7, name: "BlueBee", slug: "bluebee", logoUrl: null } },
        ]),
      });
      const service = new TeamMembersService(
        membershipRepo as never,
        makeTeamRepo() as never,
        makeUserRepo() as never,
        vi.fn()
      );

      const result = await service.listMyTeams({ userId: 9 });

      expect(result).toEqual([
        { role: MembershipRole.OWNER, id: 7, name: "BlueBee", slug: "bluebee", logoUrl: null },
      ]);
      expect(membershipRepo.findAcceptedTeamsByUserId).toHaveBeenCalledWith({ userId: 9 });
    });
  });
});
