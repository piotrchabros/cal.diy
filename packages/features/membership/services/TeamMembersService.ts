import { randomBytes } from "node:crypto";
import { sendTeamInviteEmail } from "@calcom/emails/organization-email-service";
import { validPassword } from "@calcom/features/auth/lib/validPassword";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { getTranslation } from "@calcom/i18n/server";
import { hashPassword } from "@calcom/lib/auth/hashPassword";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorWithCode } from "@calcom/lib/errors";
import { prisma } from "@calcom/prisma";
import { IdentityProvider, MembershipRole } from "@calcom/prisma/enums";

export const TEAM_MEMBER_ROLES = [MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ListTeamMembersInput = {
  teamId: number;
  viewerId: number;
  search?: string;
  roles?: MembershipRole[];
  accepted?: boolean;
  page?: number;
  pageSize?: number;
};

export type SendTeamMemberInviteEmail = (input: {
  to: string;
  teamName: string;
  joinLink: string;
  isExistingUser: boolean;
  inviterName: string;
  locale: string;
}) => Promise<void>;

const defaultSendInviteEmail: SendTeamMemberInviteEmail = async ({
  to,
  teamName,
  joinLink,
  isExistingUser,
  inviterName,
  locale,
}) => {
  const language = await getTranslation(locale ?? "en", "common");
  await sendTeamInviteEmail({
    language,
    from: inviterName,
    to,
    teamName,
    joinLink,
    isCalcomMember: isExistingUser,
    isAutoJoin: false,
    isOrg: false,
    parentTeamName: undefined,
    isExistingUserMovedToOrg: false,
    prevLink: null,
    newLink: null,
  });
};

export class TeamMembersService {
  constructor(
    private readonly membershipRepository: MembershipRepository = new MembershipRepository(),
    private readonly teamRepository: TeamRepository = new TeamRepository(),
    private readonly userRepository: UserRepository = new UserRepository(prisma),
    private readonly sendInviteEmail: SendTeamMemberInviteEmail = defaultSendInviteEmail
  ) {}

  private async requireTeamMembership(teamId: number, userId: number) {
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({ teamId, userId });
    if (!membership || !membership.accepted) {
      throw ErrorWithCode.Factory.Forbidden(`User ${userId} is not a member of team ${teamId}`);
    }
    return membership;
  }

  private async requireTeamAdmin(teamId: number, userId: number) {
    const membership = await this.requireTeamMembership(teamId, userId);
    if (membership.role !== MembershipRole.OWNER && membership.role !== MembershipRole.ADMIN) {
      throw ErrorWithCode.Factory.Forbidden(`User ${userId} lacks owner/admin access to team ${teamId}`);
    }
    return membership;
  }

  async getTeam({ teamId, viewerId }: { teamId: number; viewerId: number }) {
    await this.requireTeamMembership(teamId, viewerId);
    const team = await this.teamRepository.findBasicById({ teamId });
    if (!team) {
      throw ErrorWithCode.Factory.NotFound(`Team ${teamId} not found`);
    }
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
    await this.requireTeamMembership(teamId, viewerId);
    const team = await this.teamRepository.findBasicById({ teamId });
    if (!team) {
      throw ErrorWithCode.Factory.NotFound(`Team ${teamId} not found`);
    }
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
    await this.requireTeamAdmin(teamId, requesterId);
    const team = await this.teamRepository.findBasicById({ teamId });
    if (!team) {
      throw ErrorWithCode.Factory.NotFound(`Team ${teamId} not found`);
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      throw ErrorWithCode.Factory.BadRequest(`Invalid invite email for team ${teamId}`);
    }

    const invitee = await this.userRepository.findInviteeByEmail({ email: normalizedEmail });
    if (!invitee) {
      // Invitees without an account get one up front so they show up as pending members
      // and can set their password from the invite link instead of going through signup.
      const created = await this.userRepository.createInvitedWithPendingTeamMembership({
        email: normalizedEmail,
        teamId,
        role,
      });
      await this.sendInviteWithToken({
        teamId,
        teamName: team.name,
        email: normalizedEmail,
        inviterName: requesterName,
        locale: created.locale ?? "en",
        isExistingUser: false,
      });
      return { status: "invited-new" as const, email: normalizedEmail };
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
    await this.sendInviteWithToken({
      teamId,
      teamName: team.name,
      email: normalizedEmail,
      inviterName: requesterName,
      locale: invitee.locale ?? "en",
      isExistingUser: invitee.hasPassword,
    });
    return { status: existing ? ("already-invited" as const) : ("invited" as const), email: normalizedEmail };
  }

  private async sendInviteWithToken({
    teamId,
    teamName,
    email,
    inviterName,
    locale,
    isExistingUser,
  }: {
    teamId: number;
    teamName: string;
    email: string;
    inviterName: string;
    locale: string;
    isExistingUser: boolean;
  }) {
    const token = await this.ensureInviteToken({ teamId, email });
    await this.sendInviteEmail({
      to: email,
      teamName,
      joinLink: `${WEBAPP_URL}/auth/team-invite?token=${token}`,
      isExistingUser,
      inviterName,
      locale,
    });
  }

  private async ensureInviteToken({ teamId, email }: { teamId: number; email: string }) {
    const existing = await this.teamRepository.findTeamInviteTokenByEmail({ teamId, email });
    if (existing && existing.expires > new Date()) {
      return existing.token;
    }
    if (existing) {
      await this.teamRepository.deleteTeamInviteTokens({ teamId, email });
    }
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
    await this.teamRepository.createTeamInviteToken({ teamId, email, token, expires });
    return token;
  }

  async getInviteByToken({ token }: { token: string }) {
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
    return {
      teamId: team.id,
      teamName: team.name,
      email: invitee.email,
      // Accounts that sign in through an external identity provider must keep doing so.
      needsPassword: !invitee.hasPassword && invitee.identityProvider === IdentityProvider.CAL,
    };
  }

  async completeInviteSignup({ token, password }: { token: string; password: string }) {
    const invite = await this.getInviteByToken({ token });
    if (!invite) {
      throw ErrorWithCode.Factory.NotFound("This invitation link is invalid or has expired");
    }
    if (!invite.needsPassword) {
      throw ErrorWithCode.Factory.BadRequest(`An account for ${invite.email} already exists, please log in`);
    }
    if (!validPassword(password)) {
      throw ErrorWithCode.Factory.BadRequest("Password does not meet the requirements");
    }
    const invitee = await this.userRepository.findInviteeByEmail({ email: invite.email });
    if (!invitee) {
      throw ErrorWithCode.Factory.NotFound("This invitation link is invalid or has expired");
    }
    await this.userRepository.setPasswordAndVerifyEmail({
      id: invitee.id,
      hashedPassword: await hashPassword(password),
    });
    const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({
      teamId: invite.teamId,
      userId: invitee.id,
    });
    if (membership && !membership.accepted) {
      await this.membershipRepository.acceptTeamMembership({ teamId: invite.teamId, userId: invitee.id });
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
    await this.requireTeamAdmin(teamId, requesterId);
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
    await this.requireTeamAdmin(teamId, requesterId);
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
    await this.requireTeamAdmin(teamId, requesterId);
    const team = await this.teamRepository.findBasicById({ teamId });
    if (!team) {
      throw ErrorWithCode.Factory.NotFound(`Team ${teamId} not found`);
    }
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
    await this.sendInviteWithToken({
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
