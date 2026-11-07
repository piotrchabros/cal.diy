import { randomBytes } from "node:crypto";
import { sendTeamInviteEmail } from "@calcom/emails/organization-email-service";
import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import type { OrganizationUrlService } from "@calcom/features/organizations/services/OrganizationUrlService";
import type { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { getTranslation } from "@calcom/i18n/server";

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SendTeamInviteEmail = (input: {
  to: string;
  teamName: string;
  joinLink: string;
  isExistingUser: boolean;
  inviterName: string;
  locale: string;
  isOrganization?: boolean;
}) => Promise<void>;

export const defaultSendTeamInviteEmail: SendTeamInviteEmail = async ({
  to,
  teamName,
  joinLink,
  isExistingUser,
  inviterName,
  locale,
  isOrganization,
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
    isOrg: !!isOrganization,
    parentTeamName: undefined,
    isExistingUserMovedToOrg: false,
    prevLink: null,
    newLink: null,
  });
};

export interface ITeamInviteServiceDeps {
  teamRepository: Pick<
    TeamRepository,
    "findTeamInviteTokenByEmail" | "deleteTeamInviteTokens" | "createTeamInviteToken"
  >;
  sendInviteEmail: SendTeamInviteEmail;
  organizationUrlService?: Pick<OrganizationUrlService, "getBaseUrlForTeam">;
}

export class TeamInviteService {
  constructor(private readonly deps: ITeamInviteServiceDeps) {}

  async sendInvite({
    teamId,
    teamName,
    email,
    inviterName,
    locale,
    isExistingUser,
    isOrganization,
  }: {
    teamId: number;
    teamName: string;
    email: string;
    inviterName: string;
    locale: string;
    isExistingUser: boolean;
    isOrganization?: boolean;
  }) {
    const token = await this.ensureInviteToken({ teamId, email });
    const organizationUrlService = this.deps.organizationUrlService ?? getOrganizationUrlService();
    const baseUrl = await organizationUrlService.getBaseUrlForTeam({ teamId });
    await this.deps.sendInviteEmail({
      to: email,
      teamName,
      joinLink: `${baseUrl}/auth/team-invite?token=${token}`,
      isExistingUser,
      inviterName,
      locale,
      ...(isOrganization !== undefined ? { isOrganization } : {}),
    });
  }

  private async ensureInviteToken({ teamId, email }: { teamId: number; email: string }) {
    const existing = await this.deps.teamRepository.findTeamInviteTokenByEmail({ teamId, email });
    if (existing && existing.expires > new Date()) {
      return existing.token;
    }
    if (existing) {
      await this.deps.teamRepository.deleteTeamInviteTokens({ teamId, email });
    }
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
    await this.deps.teamRepository.createTeamInviteToken({ teamId, email, token, expires });
    return token;
  }
}
