import type {
  OrganizationMemberDto,
  OrganizationMemberListDto,
  OrganizationRoleDto,
  OrganizationTeamListDto,
} from "@calcom/lib/dto/OrganizationDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import type {
  IOrganizationMembershipRepository,
  MembershipUserRecord,
  OrganizationMemberRecord,
} from "../repositories/interfaces/IOrganizationMembershipRepository";
import type { IOrganizationRepository } from "../repositories/interfaces/IOrganizationRepository";
import type { OrganizationsConfig } from "./OrganizationService";

const log = logger.getSubLogger({ prefix: ["[OrganizationMembershipService]"] });

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export interface IOrganizationMembershipServiceDeps {
  organizationMembershipRepository: IOrganizationMembershipRepository;
  organizationRepository: IOrganizationRepository;
  organizationsConfig: OrganizationsConfig;
}

export class OrganizationMembershipService {
  constructor(private readonly deps: IOrganizationMembershipServiceDeps) {}

  async addMember(params: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; organizationId: number; role: OrganizationRoleDto }> {
    const { organizationId, userId, role } = params;
    const organization = await this.deps.organizationRepository.findById(organizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound("Organization not found");

    const user = await this.deps.organizationMembershipRepository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound("User not found");
    if (user.organizationId !== null && user.organizationId !== organizationId) {
      throw ErrorWithCode.Factory.Conflict("User belongs to another organization");
    }
    // Org profiles are keyed by username, so a user without one cannot get a profile in the org
    if (user.username === null) {
      throw ErrorWithCode.Factory.PreconditionFailed("User needs a username before joining an organization");
    }

    const usernameTaken = await this.deps.organizationMembershipRepository.isUsernameTaken({
      organizationId,
      username: user.username,
      excludeUserId: userId,
    });
    if (usernameTaken) throw ErrorWithCode.Factory.Conflict("Username is already taken in this organization");

    return this.deps.organizationMembershipRepository.addMember({
      organizationId,
      userId,
      username: user.username,
      role,
    });
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
      throw ErrorWithCode.Factory.Forbidden("Only organization owners and admins can change roles");
    }

    const targetRole = await repository.findRole({ organizationId, userId });
    if (targetRole === null) throw ErrorWithCode.Factory.NotFound("Member not found");

    if ((role === "OWNER" || targetRole === "OWNER") && actorRole !== "OWNER") {
      throw ErrorWithCode.Factory.Forbidden("Only owners can grant or remove the owner role");
    }

    if (targetRole === role) return { userId, role };

    await this.assertNotLastOwner(organizationId, userId, targetRole, role);

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

  // Removing a member never deletes the user: they fall back to the default organization (FR-011)
  async removeMember(params: {
    organizationId: number;
    actorUserId: number;
    userId: number;
  }): Promise<{ userId: number }> {
    const { organizationId, actorUserId, userId } = params;
    const repository = this.deps.organizationMembershipRepository;
    const actorRole = await this.requireManagerRole(organizationId, actorUserId);

    const { defaultDomain } = this.deps.organizationsConfig;
    const defaultOrganization = defaultDomain
      ? await this.deps.organizationRepository.findDefault(defaultDomain)
      : null;
    if (!defaultOrganization)
      throw ErrorWithCode.Factory.PreconditionFailed("Default organization not found");
    if (organizationId === defaultOrganization.id) {
      throw ErrorWithCode.Factory.PreconditionFailed(
        "Members cannot be removed from the default organization"
      );
    }

    const membership = await repository.findMembership({ organizationId, userId });
    if (!membership) throw ErrorWithCode.Factory.NotFound("Member not found");
    if (membership.role === "OWNER" && actorRole !== "OWNER") {
      throw ErrorWithCode.Factory.Forbidden("Only owners can remove an owner");
    }
    // A pending owner invite never counted as an owner, so withdrawing it cannot orphan the org
    if (membership.accepted) await this.assertNotLastOwner(organizationId, userId, membership.role, null);

    const user = await repository.findUserById(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound("Member not found");
    if (
      user.username !== null &&
      (await repository.isUsernameTaken({
        organizationId: defaultOrganization.id,
        username: user.username,
        excludeUserId: userId,
      }))
    ) {
      throw ErrorWithCode.Factory.Conflict("username_taken_in_default_organization");
    }

    await repository.moveToOrganization({
      userId,
      fromOrganizationId: organizationId,
      toOrganizationId: defaultOrganization.id,
      username: user.username,
    });

    log.info("organization.member.remove", {
      action: "organization.member.remove",
      actorUserId,
      organizationId,
      userId,
      toOrganizationId: defaultOrganization.id,
    });

    return { userId };
  }

  async getRole(userId: number, organizationId: number): Promise<OrganizationRoleDto | null> {
    return this.deps.organizationMembershipRepository.findRole({ organizationId, userId });
  }

  async findMembershipCandidate(userId: number): Promise<MembershipUserRecord | null> {
    return this.deps.organizationMembershipRepository.findUserById(userId);
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
    if (role === null) throw ErrorWithCode.Factory.NotFound("Organization not found");
    return role;
  }

  private async requireManagerRole(
    organizationId: number,
    actorUserId: number
  ): Promise<OrganizationRoleDto> {
    const role = await this.requireMemberRole(organizationId, actorUserId);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden("Only organization owners and admins can manage members");
    }
    return role;
  }

  private clampLimit(limit: number | undefined): number {
    return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  }

  private toMemberDto(record: OrganizationMemberRecord): OrganizationMemberDto {
    const { membershipId: _membershipId, ...member } = record;
    return member;
  }

  // newRole is null when the member is being removed rather than demoted
  private async assertNotLastOwner(
    organizationId: number,
    _userId: number,
    targetRole: OrganizationRoleDto,
    newRole: OrganizationRoleDto | null
  ): Promise<void> {
    if (targetRole !== "OWNER" || newRole === "OWNER") return;
    const owners = await this.deps.organizationMembershipRepository.countOwners(organizationId);
    if (owners <= 1) {
      throw ErrorWithCode.Factory.PreconditionFailed("An organization must keep at least one owner");
    }
  }
}
