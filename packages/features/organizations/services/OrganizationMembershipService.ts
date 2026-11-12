import type { TeamInviteService } from "@calcom/features/membership/services/TeamInviteService";
import { defaultUploadUserAvatar, type UploadUserAvatar } from "@calcom/features/users/lib/uploadUserAvatar";
import type { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { FULL_NAME_LENGTH_MAX_LIMIT } from "@calcom/lib/constants";
import type {
  OrganizationMemberDto,
  OrganizationMemberListDto,
  OrganizationRoleDto,
  OrganizationTeamListDto,
} from "@calcom/lib/dto/OrganizationDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { isBase64Image } from "@calcom/lib/server/resizeBase64Image";
import { slugify } from "@calcom/lib/slugify";
import { ORGANIZATION_ERRORS } from "../lib/organizationErrors";
import type {
  IOrganizationMembershipRepository,
  MembershipUserRecord,
  OrganizationMemberRecord,
} from "../repositories/interfaces/IOrganizationMembershipRepository";
import type { IOrganizationRepository } from "../repositories/interfaces/IOrganizationRepository";
import type { ITempOrgRedirectRepository } from "../repositories/interfaces/ITempOrgRedirectRepository";
import { MOVE_ERRORS, type OrganizationMoveService } from "./OrganizationMoveService";
import type { OrganizationsConfig } from "./OrganizationService";
import type { OrganizationUrlService } from "./OrganizationUrlService";

const log = logger.getSubLogger({ prefix: ["[OrganizationMembershipService]"] });

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export const USERNAME_TAKEN_IN_ORGANIZATION = ORGANIZATION_ERRORS.usernameTaken;

export interface IOrganizationMembershipServiceDeps {
  organizationMembershipRepository: IOrganizationMembershipRepository;
  organizationRepository: IOrganizationRepository;
  organizationsConfig: OrganizationsConfig;
  userRepository: Pick<UserRepository, "findInviteeByEmail" | "createInvitedWithPendingTeamMembership">;
  teamInviteService: Pick<TeamInviteService, "sendInvite">;
  tempOrgRedirectRepository: Pick<ITempOrgRedirectRepository, "disableByFrom" | "updateToUrl">;
  organizationMoveService: Pick<OrganizationMoveService, "moveUser">;
  organizationUrlService: Pick<OrganizationUrlService, "getBaseUrl">;
}

export type UpdateMemberProfileInput = {
  organizationId: number;
  actorUserId: number;
  userId: number;
  name?: string;
  username?: string;
  bio?: string;
  avatar?: string | null;
};

export class OrganizationMembershipService {
  constructor(
    private readonly deps: IOrganizationMembershipServiceDeps,
    private readonly uploadAvatar: UploadUserAvatar = defaultUploadUserAvatar
  ) {}

  async addMember(params: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
    username?: string;
  }): Promise<{ userId: number; organizationId: number; role: OrganizationRoleDto }> {
    const { organizationId, userId, role } = params;
    const organization = await this.deps.organizationRepository.findById(organizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const user = await this.deps.organizationMembershipRepository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.userNotFound);
    if (user.organizationId !== organizationId) {
      throw ErrorWithCode.Factory.Conflict(ORGANIZATION_ERRORS.userInAnotherOrganization);
    }
    // Org profiles are keyed by username, so a user without one cannot get a profile in the org
    const username = params.username ?? user.username;
    if (username === null) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.userNeedsUsername);
    }

    const usernameTaken = await this.deps.organizationMembershipRepository.isUsernameTaken({
      organizationId,
      username,
      excludeUserId: userId,
    });
    if (usernameTaken) throw ErrorWithCode.Factory.Conflict(USERNAME_TAKEN_IN_ORGANIZATION);

    const member = await this.deps.organizationMembershipRepository.addMember({
      organizationId,
      userId,
      username,
      role,
    });
    // A username freed by a move may still redirect to the moved user's new org; the new owner wins
    await this.deps.tempOrgRedirectRepository.disableByFrom({
      fromOrgId: organizationId,
      from: username,
      types: ["User"],
    });
    return member;
  }

  async changeUsername(params: { userId: number; username: string }): Promise<void> {
    const { userId, username } = params;
    const repository = this.deps.organizationMembershipRepository;

    const user = await repository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.userNotFound);

    const { organizationId } = user;
    const usernameTaken = await repository.isUsernameTaken({
      organizationId,
      username,
      excludeUserId: userId,
    });
    if (usernameTaken) throw ErrorWithCode.Factory.Conflict(USERNAME_TAKEN_IN_ORGANIZATION);

    const membership = await repository.findMembership({ organizationId, userId });
    if (membership?.accepted) {
      await repository.updateUsernameAndUpsertProfile({ userId, organizationId, username });
      return;
    }
    // A pending invitee must not become publicly visible in the org before accepting; addMember creates
    // their profile on acceptance
    await repository.updateUsername({ userId, organizationId, username });
  }

  async setRole(params: {
    organizationId: number;
    actorUserId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; role: OrganizationRoleDto }> {
    const { organizationId, actorUserId, userId, role } = params;
    const repository = this.deps.organizationMembershipRepository;

    const actorRole = await repository.findRole({ organizationId, userId: actorUserId });
    if (actorRole === null || actorRole === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanChangeRoles);
    }

    const targetRole = await repository.findRole({ organizationId, userId });
    if (targetRole === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);

    if ((role === "OWNER" || targetRole === "OWNER") && actorRole !== "OWNER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyOwnersCanManageOwnerRole);
    }

    if (targetRole === role) return { userId, role };

    // findRole only returns accepted memberships
    await this.assertNotLastOwner(organizationId, { role: targetRole, accepted: true }, role);

    const updated = await repository.updateRole({ organizationId, userId, role });
    log.info("organization.member.role", {
      action: "organization.member.role",
      actorUserId,
      organizationId,
      userId,
      role,
    });
    return updated;
  }

  // Managers edit other members only; their own profile is edited in account settings
  async updateMemberProfile(params: UpdateMemberProfileInput): Promise<OrganizationMemberDto> {
    const { organizationId, actorUserId, userId } = params;
    const repository = this.deps.organizationMembershipRepository;
    const actorRole = await this.requireManagerRole(organizationId, actorUserId);
    if (userId === actorUserId) {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.editOwnProfileInAccountSettings);
    }

    // Pending invitees are editable too; the organizationId check below keeps users who belong to another org out
    const targetMembership = await repository.findMembership({ organizationId, userId });
    if (!targetMembership) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);
    if (targetMembership.role === "OWNER" && actorRole !== "OWNER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyOwnersCanEditOwner);
    }

    const user = await repository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);
    if (user.organizationId !== organizationId) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.memberNotInOrganization);
    }

    // Validate every field up front so a bad value never leaves a half-applied edit behind
    const name = params.name === undefined ? undefined : this.parseMemberName(params.name);
    const username = params.username === undefined ? undefined : this.parseUsername(params.username);
    const bio = params.bio?.trim();
    if (typeof params.avatar === "string" && !isBase64Image(params.avatar)) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.memberAvatarInvalid);
    }

    const changedFields: string[] = [];
    if (username !== undefined && username !== user.username) {
      await this.changeUsername({ userId, username });
      await this.syncRedirectsAfterRename(organizationId, user.username, username);
      changedFields.push("username");
    }

    const data: { name?: string; bio?: string; avatarUrl?: string | null } = {};
    if (name !== undefined) data.name = name;
    if (bio !== undefined) data.bio = bio;
    if (typeof params.avatar === "string") {
      data.avatarUrl = await this.uploadAvatar({ userId, avatar: params.avatar });
    } else if (params.avatar === null) {
      data.avatarUrl = null;
    }

    const profileFields = Object.keys(data);
    if (profileFields.length > 0) {
      await repository.updateUserProfile({ userId, data });
      changedFields.push(...profileFields);
    }

    log.info("organization.member.profile", {
      action: "organization.member.profile",
      actorUserId,
      organizationId,
      userId,
      fields: changedFields,
    });

    const member = await repository.findMember({ organizationId, userId });
    if (!member) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);
    return this.toMemberDto(member);
  }

  // Removing a member never deletes the user: they are moved to the default organization (FR-011). As a
  // move it also leaves a redirect on the old domain like FR-018 moves (T181) until the username is reused
  async removeMember(params: {
    organizationId: number;
    actorUserId: number;
    userId: number;
    newUsername?: string;
  }): Promise<{ userId: number }> {
    const { organizationId, actorUserId, userId } = params;
    const repository = this.deps.organizationMembershipRepository;
    const actorRole = await this.requireManagerRole(organizationId, actorUserId);

    const { defaultDomain } = this.deps.organizationsConfig;
    const defaultOrganization = defaultDomain
      ? await this.deps.organizationRepository.findDefault(defaultDomain)
      : null;
    if (!defaultOrganization)
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.defaultNotFound);
    if (organizationId === defaultOrganization.id) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.cannotRemoveFromDefault);
    }

    const membership = await repository.findMembership({ organizationId, userId });
    if (!membership) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);
    if (membership.role === "OWNER" && actorRole !== "OWNER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyOwnersCanRemoveOwner);
    }
    await this.assertNotLastOwner(organizationId, membership, null);

    const user = await repository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);
    // moveUser moves the user out of user.organizationId, not this org; a user already in the default
    // org would also get their default profile recreated
    if (user.organizationId !== organizationId) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.memberNotInOrganization);
    }

    try {
      await this.deps.organizationMoveService.moveUser(
        { userId, toOrganizationId: defaultOrganization.id, newUsername: params.newUsername },
        actorUserId,
        { allowMissingUsername: true }
      );
    } catch (error) {
      if (
        error instanceof ErrorWithCode &&
        error.code === ErrorCode.Conflict &&
        error.message === MOVE_ERRORS.usernameTaken
      ) {
        throw ErrorWithCode.Factory.Conflict(ORGANIZATION_ERRORS.usernameTakenInDefault);
      }
      throw error;
    }

    log.info("organization.member.remove", {
      action: "organization.member.remove",
      actorUserId,
      organizationId,
      userId,
      toOrganizationId: defaultOrganization.id,
    });

    return { userId };
  }

  // Org invites reuse the team invite pipeline: the org row is a team, so its id doubles as teamId
  async inviteMember(params: {
    organizationId: number;
    actorUserId: number;
    actorName: string;
    email: string;
    role: OrganizationRoleDto;
  }): Promise<{ invited: true }> {
    const { organizationId, actorUserId, role } = params;
    const actorRole = await this.requireManagerRole(organizationId, actorUserId);
    if (role === "OWNER" && actorRole !== "OWNER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyOwnersCanManageOwnerRole);
    }

    return this.sendOrganizationInvite(params);
  }

  // Instance admins aren't members of the org they create, so there is no actor role to check
  async inviteOwner({
    organizationId,
    email,
    inviterName,
  }: {
    organizationId: number;
    email: string;
    inviterName: string;
  }): Promise<{ invited: true }> {
    return this.sendOrganizationInvite({
      organizationId,
      actorUserId: null,
      actorName: inviterName,
      email,
      role: "OWNER",
    });
  }

  // Additive: existing owners keep their role, the user just becomes one more owner
  async grantOwner({
    organizationId,
    userId,
    actorUserId,
  }: {
    organizationId: number;
    userId: number;
    actorUserId: number;
  }): Promise<{ userId: number; role: "OWNER" }> {
    const repository = this.deps.organizationMembershipRepository;
    const membership = await repository.findMembership({ organizationId, userId });
    if (membership?.accepted) {
      if (membership.role !== "OWNER") await repository.updateRole({ organizationId, userId, role: "OWNER" });
      this.logOwnerGrant(organizationId, userId, actorUserId);
      return { userId, role: "OWNER" };
    }

    const user = await repository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.ownerNotFound);
    if (user.username === null) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.ownerNeedsUsername);
    }
    if (user.organizationId !== organizationId) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.ownerInAnotherOrganization);
    }

    const member = await this.addMember({ organizationId, userId, role: "OWNER" });
    // Accepting a pending invite keeps the role it was sent with, so it has to be raised separately
    if (member.role !== "OWNER") await repository.updateRole({ organizationId, userId, role: "OWNER" });
    this.logOwnerGrant(organizationId, userId, actorUserId);
    return { userId, role: "OWNER" };
  }

  // Deleting a user cascades their memberships away, so the last owner would leave the org ownerless (FR-003)
  async assertUserCanBeDeleted(userId: number): Promise<void> {
    const repository = this.deps.organizationMembershipRepository;
    const user = await repository.findUserById(userId);
    if (!user) return;
    const membership = await repository.findMembership({ organizationId: user.organizationId, userId });
    if (!membership) return;
    await this.assertNotLastOwner(
      user.organizationId,
      membership,
      null,
      ORGANIZATION_ERRORS.lastOwnerCannotBeDeleted
    );
  }

  // Instance admins manage owners without being org members, so there is no actor role to check (US1-5)
  async demoteOwner({
    organizationId,
    userId,
    role,
    actorUserId,
  }: {
    organizationId: number;
    userId: number;
    role: Exclude<OrganizationRoleDto, "OWNER">;
    actorUserId: number;
  }): Promise<{ userId: number; role: OrganizationRoleDto }> {
    const repository = this.deps.organizationMembershipRepository;
    const membership = await repository.findMembership({ organizationId, userId });
    if (!membership) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.memberNotFound);
    if (membership.role !== "OWNER") {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.memberNotOwner);
    }

    await this.assertNotLastOwner(organizationId, membership, role);

    const updated = await repository.updateRole({ organizationId, userId, role });
    log.info("organization.owner.demote", {
      action: "organization.owner.demote",
      actorUserId,
      organizationId,
      userId,
      role,
    });
    return updated;
  }

  private logOwnerGrant(organizationId: number, userId: number, actorUserId: number): void {
    log.info("organization.owner.grant", {
      action: "organization.owner.grant",
      actorUserId,
      organizationId,
      userId,
    });
  }

  private async sendOrganizationInvite(params: {
    organizationId: number;
    actorUserId: number | null;
    actorName: string;
    email: string;
    role: OrganizationRoleDto;
  }): Promise<{ invited: true }> {
    const { organizationId, actorUserId, actorName, role } = params;
    const organization = await this.deps.organizationRepository.findById(organizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const email = params.email.trim().toLowerCase();
    if (!email || !email.includes("@"))
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.invalidInviteEmail);

    const sendInvite = (locale: string | null, isExistingUser: boolean) =>
      this.deps.teamInviteService.sendInvite({
        teamId: organizationId,
        teamName: organization.name,
        email,
        inviterName: actorName,
        locale: locale ?? "en",
        isExistingUser,
        isOrganization: true,
      });

    const invitee = await this.deps.userRepository.findInviteeByEmail({ email });
    let targetUserId: number;
    if (!invitee) {
      const created = await this.deps.userRepository.createInvitedWithPendingTeamMembership({
        email,
        teamId: organizationId,
        role,
        organizationId,
      });
      targetUserId = created.id;
      await sendInvite(created.locale, false);
    } else {
      if (invitee.organizationId !== organizationId) {
        throw ErrorWithCode.Factory.Conflict(ORGANIZATION_ERRORS.userInAnotherOrganization);
      }
      targetUserId = invitee.id;
      const membership = await this.deps.organizationMembershipRepository.findMembership({
        organizationId,
        userId: invitee.id,
      });
      if (membership?.accepted) throw ErrorWithCode.Factory.Conflict(ORGANIZATION_ERRORS.alreadyMember);

      if (!membership && invitee.username) {
        await this.addMember({ organizationId, userId: invitee.id, role });
      } else if (!membership) {
        // Without a username there is no org profile yet, so the invitee stays pending until they accept
        await this.deps.organizationMembershipRepository.createPendingMembership({
          organizationId,
          userId: invitee.id,
          role,
        });
      }
      await sendInvite(invitee.locale, invitee.hasPassword);
    }

    log.info("organization.member.invite", {
      action: "organization.member.invite",
      actorUserId,
      organizationId,
      targetUserId,
      role,
    });

    return { invited: true };
  }

  async getRole(userId: number, organizationId: number): Promise<OrganizationRoleDto | null> {
    return this.deps.organizationMembershipRepository.findRole({ organizationId, userId });
  }

  async findMembershipCandidate(userId: number): Promise<MembershipUserRecord | null> {
    return this.deps.organizationMembershipRepository.findUserById(userId);
  }

  async findMembershipCandidateByEmail(email: string): Promise<MembershipUserRecord | null> {
    return this.deps.organizationMembershipRepository.findUserByEmail(email.trim().toLowerCase());
  }

  async listMembers(params: {
    organizationId: number;
    actorUserId: number;
    search?: string;
    cursor?: number;
    limit?: number;
  }): Promise<OrganizationMemberListDto> {
    const { organizationId, actorUserId } = params;
    await this.requireMemberRole(organizationId, actorUserId);

    const page = await this.deps.organizationMembershipRepository.listMembers({
      organizationId,
      search: params.search,
      cursor: params.cursor,
      limit: this.clampLimit(params.limit),
    });

    log.debug("organization.member.list", {
      action: "organization.member.list",
      actorUserId,
      organizationId,
    });

    return { items: page.items.map((record) => this.toMemberDto(record)), nextCursor: page.nextCursor };
  }

  async listTeams(params: {
    organizationId: number;
    actorUserId: number;
    search?: string;
    cursor?: number;
    limit?: number;
  }): Promise<OrganizationTeamListDto> {
    const { organizationId, actorUserId } = params;
    const role = await this.requireMemberRole(organizationId, actorUserId);

    // Owners and admins manage every team in the org; plain members only see teams they belong to
    const page = await this.deps.organizationMembershipRepository.listTeams({
      organizationId,
      viewerUserId: actorUserId,
      memberUserId: role === "MEMBER" ? actorUserId : undefined,
      search: params.search,
      cursor: params.cursor,
      limit: this.clampLimit(params.limit),
    });

    log.debug("organization.team.list", { action: "organization.team.list", actorUserId, organizationId });

    return { items: page.items, nextCursor: page.nextCursor };
  }

  // Pending invitees have no accepted membership, so they are treated like outsiders and the org stays hidden
  private async requireMemberRole(organizationId: number, actorUserId: number): Promise<OrganizationRoleDto> {
    const role = await this.deps.organizationMembershipRepository.findRole({
      organizationId,
      userId: actorUserId,
    });
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    return role;
  }

  private async requireManagerRole(
    organizationId: number,
    actorUserId: number
  ): Promise<OrganizationRoleDto> {
    const role = await this.requireMemberRole(organizationId, actorUserId);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanManageMembers);
    }
    return role;
  }

  private parseMemberName(value: string): string {
    const name = value.trim();
    if (!name || name.length > FULL_NAME_LENGTH_MAX_LIMIT) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.memberNameInvalid);
    }
    return name;
  }

  private parseUsername(value: string): string {
    const username = slugify(value);
    // Reject rather than silently rewrite so the manager sees the exact URL the member will get
    if (!username || username !== value.trim().toLowerCase()) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.invalidUsername);
    }
    return username;
  }

  // Same redirect handling as repointUserRedirectsForRename and disableUserRedirectsForReusedUsername, but
  // through injected dependencies instead of the DI containers those helpers resolve
  private async syncRedirectsAfterRename(
    organizationId: number,
    oldUsername: string | null,
    newUsername: string
  ): Promise<void> {
    const redirects = this.deps.tempOrgRedirectRepository;
    if (oldUsername && oldUsername !== newUsername) {
      const baseUrl = await this.deps.organizationUrlService.getBaseUrl({ organizationId });
      await redirects.updateToUrl({
        types: ["User"],
        toUrl: `${baseUrl}/${oldUsername}`,
        newToUrl: `${baseUrl}/${newUsername}`,
      });
    }
    await redirects.disableByFrom({ fromOrgId: organizationId, from: newUsername, types: ["User"] });
  }

  private clampLimit(limit: number | undefined): number {
    return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  }

  private toMemberDto(record: OrganizationMemberRecord): OrganizationMemberDto {
    const { membershipId: _membershipId, ...member } = record;
    // Legacy avatars are inline data: URLs that would bloat the member list payload
    const avatarUrl = member.avatarUrl?.startsWith("data:") ? null : member.avatarUrl;
    return { ...member, avatarUrl };
  }

  // newRole is null when the member is being removed rather than demoted. An organization created with an
  // email owner has no accepted owner until that invite is accepted, so its last pending owner invite
  // must stay too (FR-003)
  private async assertNotLastOwner(
    organizationId: number,
    membership: { role: OrganizationRoleDto; accepted: boolean },
    newRole: OrganizationRoleDto | null,
    errorKey: string = ORGANIZATION_ERRORS.lastOwner
  ): Promise<void> {
    if (membership.role !== "OWNER" || newRole === "OWNER") return;
    const repository = this.deps.organizationMembershipRepository;
    const acceptedOwners = await repository.countOwners(organizationId);
    if (membership.accepted) {
      if (acceptedOwners <= 1) throw ErrorWithCode.Factory.PreconditionFailed(errorKey);
      return;
    }
    if (acceptedOwners > 0) return;
    if ((await repository.countPendingOwners(organizationId)) <= 1) {
      throw ErrorWithCode.Factory.PreconditionFailed(errorKey);
    }
  }
}
