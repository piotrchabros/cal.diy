import { validPassword } from "@calcom/features/auth/lib/validPassword";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { getOrganizationMembershipService as defaultGetOrganizationMembershipService } from "@calcom/features/organizations/di/OrganizationMembershipService.container";
import {
  type OrganizationMembershipService,
  USERNAME_TAKEN_IN_ORGANIZATION,
} from "@calcom/features/organizations/services/OrganizationMembershipService";
import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { hashPassword } from "@calcom/lib/auth/hashPassword";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import slugify from "@calcom/lib/slugify";
import { prisma } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { defaultSendTeamInviteEmail, type SendTeamInviteEmail, TeamInviteService } from "./TeamInviteService";

type TeamWithParent = { id: number; parentId: number | null };

type TeamInviteDto = {
  teamId: number;
  teamName: string;
  email: string;
  isOrganization: boolean;
  needsPassword: boolean;
  needsUsername: boolean;
};

export const TEAM_MEMBER_ROLES = [MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

export type ListTeamMembersInput = {
  teamId: number;
  viewerId: number;
  search?: string;
  roles?: MembershipRole[];
  accepted?: boolean;
  page?: number;
  pageSize?: number;
};

export type SendTeamMemberInviteEmail = SendTeamInviteEmail;

export class TeamMembersService {
  private readonly teamInviteService: TeamInviteService;

  constructor(
    private readonly membershipRepository: MembershipRepository = new MembershipRepository(),
    private readonly teamRepository: TeamRepository = new TeamRepository(),
    private readonly userRepository: UserRepository = new UserRepository(prisma),
    sendInviteEmail: SendTeamMemberInviteEmail = defaultSendTeamInviteEmail,
    private readonly getOrganizationMembershipService: () => Pick<
      OrganizationMembershipService,
      "addMember" | "getRole"
    > = defaultGetOrganizationMembershipService
  ) {
    this.teamInviteService = new TeamInviteService({ teamRepository, sendInviteEmail });
  }

  // Organization rows live in the team table too; rejecting them here keeps team endpoints
  // (and the team settings pages built on them) from managing an organization as a team.
  private async requireTeam(teamId: number) {
    const team = await this.teamRepository.findBasicById({ teamId });
    if (!team || team.isOrganization) {
      throw ErrorWithCode.Factory.NotFound(`Team ${teamId} not found`);
    }
    return team;
  }

  private async isOrganizationAdminOfTeam(team: TeamWithParent, userId: number) {
    if (!isOrganizationsEnabled() || team.parentId === null) {
      return false;
    }
    const role = await this.getOrganizationMembershipService().getRole(userId, team.parentId);
    return role === "OWNER" || role === "ADMIN";
  }

  private async requireTeamAccess(team: TeamWithParent, userId: number) {
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({
      teamId: team.id,
      userId,
    });
    if (membership?.accepted) {
      return;
    }
    if (await this.isOrganizationAdminOfTeam(team, userId)) {
      return;
    }
    this.throwNotVisible(team.id, userId);
  }

  private async requireTeamAdmin(team: TeamWithParent, userId: number) {
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({
      teamId: team.id,
      userId,
    });
    if (
      membership?.accepted &&
      (membership.role === MembershipRole.OWNER || membership.role === MembershipRole.ADMIN)
    ) {
      return;
    }
    if (await this.isOrganizationAdminOfTeam(team, userId)) {
      return;
    }
    if (!membership?.accepted) {
      this.throwNotVisible(team.id, userId);
    }
    throw ErrorWithCode.Factory.Forbidden(`User ${userId} lacks owner/admin access to team ${team.id}`);
  }

  private throwNotVisible(teamId: number, userId: number): never {
    // FR-008: with organizations on, a team the caller cannot see must look nonexistent so
    // another organization's team ids cannot be probed.
    if (isOrganizationsEnabled()) {
      throw ErrorWithCode.Factory.NotFound("Team not found");
    }
    throw ErrorWithCode.Factory.Forbidden(`User ${userId} is not a member of team ${teamId}`);
  }

  async getTeam({ teamId, viewerId }: { teamId: number; viewerId: number }) {
    const team = await this.requireTeam(teamId);
    await this.requireTeamAccess(team, viewerId);
    return team;
  }

  async listMembers({
    teamId,
    viewerId,
    search,
    roles,
    accepted,
    page = 1,
    pageSize = 10,
  }: ListTeamMembersInput) {
    const team = await this.requireTeam(teamId);
    await this.requireTeamAccess(team, viewerId);
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const [items, total] = await Promise.all([
      this.membershipRepository.findTeamMembers({
        teamId,
        search,
        roles,
        accepted,
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
      }),
      this.membershipRepository.countTeamMembers({ teamId, search, roles, accepted }),
    ]);
    return {
      team,
      items,
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  async inviteMember({
    teamId,
    requesterId,
    requesterName,
    email,
    role,
  }: {
    teamId: number;
    requesterId: number;
    requesterName: string;
    email: string;
    role: TeamMemberRole;
  }) {
    const team = await this.requireTeam(teamId);
    await this.requireTeamAdmin(team, requesterId);
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      throw ErrorWithCode.Factory.BadRequest(`Invalid invite email for team ${teamId}`);
    }
    // A team inside an organization only admits that organization's people, so invitees are
    // checked against (or attached to) the parent organization before joining the team.
    const organizationId = isOrganizationsEnabled() ? team.parentId : null;

    const invitee = await this.userRepository.findInviteeByEmail({ email: normalizedEmail });
    if (!invitee) {
      // Invitees without an account get one up front so they show up as pending members
      // and can set their password from the invite link instead of going through signup.
      const created = await this.userRepository.createInvitedWithPendingTeamMembership({
        email: normalizedEmail,
        teamId,
        role,
        organizationId,
      });
      await this.teamInviteService.sendInvite({
        teamId,
        teamName: team.name,
        email: normalizedEmail,
        inviterName: requesterName,
        locale: created.locale ?? "en",
        isExistingUser: false,
      });
      return { status: "invited-new" as const, email: normalizedEmail };
    }

    if (organizationId !== null) {
      await this.assertInviteeCanJoinOrganization(invitee, organizationId);
    }

    const existing = await this.membershipRepository.findUniqueByUserIdAndTeamId({
      teamId,
      userId: invitee.id,
    });
    if (existing?.accepted) {
      throw ErrorWithCode.Factory.BadRequest(`${normalizedEmail} is already a member of ${team.name}`);
    }
    if (!existing) {
      await this.membershipRepository.createTeamMembership({
        teamId,
        userId: invitee.id,
        role,
        accepted: false,
      });
    }
    await this.teamInviteService.sendInvite({
      teamId,
      teamName: team.name,
      email: normalizedEmail,
      inviterName: requesterName,
      locale: invitee.locale ?? "en",
      isExistingUser: invitee.hasPassword,
    });
    return { status: existing ? ("already-invited" as const) : ("invited" as const), email: normalizedEmail };
  }

  private async assertInviteeCanJoinOrganization(
    invitee: { id: number; organizationId: number | null; username: string | null },
    organizationId: number
  ) {
    if (invitee.organizationId !== null && invitee.organizationId !== organizationId) {
      throw ErrorWithCode.Factory.Conflict("user_belongs_to_another_organization");
    }
    if (invitee.organizationId !== null) {
      return;
    }
    if (invitee.username) {
      await this.getOrganizationMembershipService().addMember({
        organizationId,
        userId: invitee.id,
        role: "MEMBER",
      });
      return;
    }
    // addMember needs a username for the organization profile; that profile is created once
    // the invitee finishes signup, so for now only the organization link is recorded.
    await this.userRepository.setOrganizationId({ id: invitee.id, organizationId });
  }

  private getInviteOrganizationId(team: TeamWithParent & { isOrganization: boolean }) {
    if (!isOrganizationsEnabled()) {
      return null;
    }
    return team.isOrganization ? team.id : team.parentId;
  }

  private async resolveInvite(
    token: string
  ): Promise<{ invite: TeamInviteDto; organizationId: number | null; inviteeId: number } | null> {
    const invite = await this.teamRepository.findTeamInviteByToken({ token });
    if (!invite || invite.teamId === null || invite.expires <= new Date()) {
      return null;
    }
    const [team, invitee] = await Promise.all([
      this.teamRepository.findBasicById({ teamId: invite.teamId }),
      this.userRepository.findInviteeByEmail({ email: invite.identifier }),
    ]);
    if (!team || !invitee) {
      return null;
    }
    const organizationId = this.getInviteOrganizationId(team);
    return {
      invite: {
        teamId: team.id,
        teamName: team.name,
        email: invitee.email,
        isOrganization: team.isOrganization,
        // Passwordless accounts include admin-created GOOGLE ones, which cannot sign in while
        // Google login is disabled; the emailed token proves mailbox ownership like a reset link.
        needsPassword: !invitee.hasPassword,
        // Organization invitees are created without a username, but the organization profile
        // needs one; the invitee picks it here and it only has to be free in this organization.
        needsUsername: organizationId !== null && invitee.username === null,
      },
      organizationId,
      inviteeId: invitee.id,
    };
  }

  async getInviteByToken({ token }: { token: string }): Promise<TeamInviteDto | null> {
    return (await this.resolveInvite(token))?.invite ?? null;
  }

  async completeInviteSignup({
    token,
    password,
    username,
  }: {
    token: string;
    password?: string;
    username?: string;
  }) {
    const resolved = await this.resolveInvite(token);
    if (!resolved) {
      throw ErrorWithCode.Factory.NotFound("This invitation link is invalid or has expired");
    }
    const { invite, organizationId, inviteeId } = resolved;
    if (!invite.needsPassword && !invite.needsUsername) {
      throw ErrorWithCode.Factory.BadRequest(`An account for ${invite.email} already exists, please log in`);
    }
    if (invite.needsPassword && (!password || !validPassword(password))) {
      throw ErrorWithCode.Factory.BadRequest("Password does not meet the requirements");
    }
    if (invite.needsUsername && organizationId !== null) {
      const orgUsername = slugify(username ?? "");
      if (!orgUsername) {
        throw ErrorWithCode.Factory.BadRequest("A username is required to join this organization");
      }
      // Joining the organization goes first so a taken username fails before the password is
      // set; the upsert keeps a pending membership's role and accepts it.
      try {
        await this.getOrganizationMembershipService().addMember({
          organizationId,
          userId: inviteeId,
          role: "MEMBER",
          username: orgUsername,
        });
      } catch (error) {
        if (
          error instanceof ErrorWithCode &&
          error.code === ErrorCode.Conflict &&
          error.message === USERNAME_TAKEN_IN_ORGANIZATION
        ) {
          throw ErrorWithCode.Factory.Conflict("username_taken_in_organization");
        }
        throw error;
      }
    }
    if (invite.needsPassword && password) {
      await this.userRepository.switchToPasswordLogin({
        id: inviteeId,
        hashedPassword: await hashPassword(password),
      });
    }
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({
      teamId: invite.teamId,
      userId: inviteeId,
    });
    if (membership && !membership.accepted) {
      await this.membershipRepository.acceptTeamMembership({ teamId: invite.teamId, userId: inviteeId });
    }
    await this.teamRepository.deleteTeamInviteTokens({ teamId: invite.teamId, email: invite.email });
    return { email: invite.email, teamId: invite.teamId };
  }

  async acceptPendingInvitesOnSignup({ userId, email }: { userId: number; email: string }) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return { status: "no-invites" as const, teamIds: [] as number[] };
    }
    const invites = await this.teamRepository.findTeamInviteTokensByEmail({ email: normalizedEmail });
    const now = new Date();
    const acceptedTeamIds: number[] = [];
    for (const invite of invites) {
      if (invite.teamId === null || invite.expires <= now) {
        continue;
      }
      await this.membershipRepository.upsertAcceptedTeamMembership({ teamId: invite.teamId, userId });
      await this.teamRepository.deleteTeamInviteTokens({ teamId: invite.teamId, email: normalizedEmail });
      if (!acceptedTeamIds.includes(invite.teamId)) {
        acceptedTeamIds.push(invite.teamId);
      }
    }
    return {
      status: (acceptedTeamIds.length > 0 ? "accepted" : "no-invites") as "accepted" | "no-invites",
      teamIds: acceptedTeamIds,
    };
  }

  async acceptInvite({ teamId, userId }: { teamId: number; userId: number }) {
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({ teamId, userId });
    if (!membership) {
      throw ErrorWithCode.Factory.NotFound(`No invitation found for user ${userId} in team ${teamId}`);
    }
    if (membership.accepted) {
      return { status: "already-accepted" as const };
    }
    await this.membershipRepository.acceptTeamMembership({ teamId, userId });
    return { status: "accepted" as const };
  }

  async updateMemberRole({
    teamId,
    requesterId,
    userId,
    role,
  }: {
    teamId: number;
    requesterId: number;
    userId: number;
    role: TeamMemberRole;
  }) {
    const team = await this.requireTeam(teamId);
    await this.requireTeamAdmin(team, requesterId);
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({ teamId, userId });
    if (!membership) {
      throw ErrorWithCode.Factory.NotFound(`User ${userId} is not a member of team ${teamId}`);
    }
    if (membership.role === MembershipRole.OWNER && role !== MembershipRole.OWNER) {
      const ownerCount = await this.membershipRepository.countAcceptedOwnersByTeamId({ teamId });
      if (ownerCount <= 1) {
        throw ErrorWithCode.Factory.BadRequest(`Team ${teamId} must keep at least one owner`);
      }
    }
    return await this.membershipRepository.updateTeamMembershipRole({ teamId, userId, role });
  }

  async removeMember({
    teamId,
    requesterId,
    userId,
  }: {
    teamId: number;
    requesterId: number;
    userId: number;
  }) {
    const team = await this.requireTeam(teamId);
    await this.requireTeamAdmin(team, requesterId);
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({ teamId, userId });
    if (!membership) {
      throw ErrorWithCode.Factory.NotFound(`User ${userId} is not a member of team ${teamId}`);
    }
    if (membership.accepted && membership.role === MembershipRole.OWNER) {
      const ownerCount = await this.membershipRepository.countAcceptedOwnersByTeamId({ teamId });
      if (ownerCount <= 1) {
        throw ErrorWithCode.Factory.BadRequest(`Team ${teamId} must keep at least one owner`);
      }
    }
    await this.membershipRepository.deleteTeamMembership({ teamId, userId });
    return { id: membership.id };
  }

  async resendInvite({
    teamId,
    requesterId,
    requesterName,
    email,
  }: {
    teamId: number;
    requesterId: number;
    requesterName: string;
    email: string;
  }) {
    const team = await this.requireTeam(teamId);
    await this.requireTeamAdmin(team, requesterId);
    const normalizedEmail = email.trim().toLowerCase();
    const invitee = await this.userRepository.findInviteeByEmail({ email: normalizedEmail });
    if (!invitee) {
      throw ErrorWithCode.Factory.BadRequest(`No pending invitation for ${normalizedEmail}`);
    }
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({
      teamId,
      userId: invitee.id,
    });
    if (!membership || membership.accepted) {
      throw ErrorWithCode.Factory.BadRequest(`No pending invitation for ${normalizedEmail}`);
    }
    await this.teamInviteService.sendInvite({
      teamId,
      teamName: team.name,
      email: normalizedEmail,
      inviterName: requesterName,
      locale: invitee.locale ?? "en",
      isExistingUser: invitee.hasPassword,
    });
    return { status: "resent" as const, email: normalizedEmail };
  }
}
