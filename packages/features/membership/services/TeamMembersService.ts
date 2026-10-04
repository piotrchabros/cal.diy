import { sendTeamInviteEmail } from "@calcom/emails/organization-email-service";
import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { getTranslation } from "@calcom/i18n/server";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorWithCode } from "@calcom/lib/errors";
import { prisma } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { randomBytes } from "node:crypto";

import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";

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
      throw ErrorWithCode.Factory.Forbidden(
        `User ${userId} lacks owner/admin access to team ${teamId}`
      );
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
    if (invitee) {
      const existing = await this.membershipRepository.findUniqueByUserIdAndTeamId({
        teamId,
        userId: invitee.id,
      });
      if (existing?.accepted) {
        throw ErrorWithCode.Factory.BadRequest(`${normalizedEmail} is already a member of ${team.name}`);
      }
      const joinLink = `${WEBAPP_URL}/settings/my-teams/${teamId}/members`;
      if (existing && !existing.accepted) {
        await this.sendInviteEmail({
          to: normalizedEmail,
          teamName: team.name,
          joinLink,
          isExistingUser: true,
          inviterName: requesterName,
          locale: invitee.locale ?? "en",
        });
        return { status: "already-invited" as const, email: normalizedEmail };
      }
      await this.membershipRepository.createTeamMembership({
        teamId,
        userId: invitee.id,
        role,
        accepted: false,
      });
      await this.sendInviteEmail({
        to: normalizedEmail,
        teamName: team.name,
        joinLink,
        isExistingUser: true,
        inviterName: requesterName,
        locale: invitee.locale ?? "en",
      });
      return { status: "invited" as const, email: normalizedEmail };
    }

    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.teamRepository.createTeamInviteToken({ teamId, email: normalizedEmail, token, expires });
    await this.sendInviteEmail({
      to: normalizedEmail,
      teamName: team.name,
      joinLink: `${WEBAPP_URL}/signup?token=${token}&callbackUrl=${encodeURIComponent(
        `/settings/my-teams/${teamId}/members`
      )}`,
      isExistingUser: false,
      inviterName: requesterName,
      locale: "en",
    });
    return { status: "invited-new" as const, email: normalizedEmail };
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
    const joinLink = `${WEBAPP_URL}/settings/my-teams/${teamId}/members`;
    if (invitee) {
      const membership = await this.membershipRepository.findUniqueByUserIdAndTeamId({
        teamId,
        userId: invitee.id,
      });
      if (!membership || membership.accepted) {
        throw ErrorWithCode.Factory.BadRequest(`No pending invitation for ${normalizedEmail}`);
      }
      await this.sendInviteEmail({
        to: normalizedEmail,
        teamName: team.name,
        joinLink,
        isExistingUser: true,
        inviterName: requesterName,
        locale: invitee.locale ?? "en",
      });
      return { status: "resent" as const, email: normalizedEmail };
    }
    const existing = await this.teamRepository.findTeamInviteTokenByEmail({
      teamId,
      email: normalizedEmail,
    });
    if (!existing) {
      throw ErrorWithCode.Factory.BadRequest(`No pending invitation for ${normalizedEmail}`);
    }
    let tokenValue = existing.token;
    if (existing.expires <= new Date()) {
      tokenValue = randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await this.teamRepository.deleteTeamInviteTokens({ teamId, email: normalizedEmail });
      await this.teamRepository.createTeamInviteToken({
        teamId,
        email: normalizedEmail,
        token: tokenValue,
        expires,
      });
    }
    await this.sendInviteEmail({
      to: normalizedEmail,
      teamName: team.name,
      joinLink: `${WEBAPP_URL}/signup?token=${tokenValue}&callbackUrl=${encodeURIComponent(
        `/settings/my-teams/${teamId}/members`
      )}`,
      isExistingUser: false,
      inviterName: requesterName,
      locale: "en",
    });
    return { status: "resent" as const, email: normalizedEmail };
  }
}
