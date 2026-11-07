import type { OrganizationRoleDto, OrganizationTeamListDto } from "@calcom/lib/dto/OrganizationDto";
import type {
  MoveTeamPreviewDto,
  MoveTeamResultDto,
  MoveUserResultDto,
} from "@calcom/lib/dto/OrganizationMoveDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { slugify } from "@calcom/lib/slugify";
import type { IOrganizationMembershipRepository } from "../repositories/interfaces/IOrganizationMembershipRepository";
import type {
  ApplyUserMove,
  IOrganizationMoveRepository,
  MoveRedirectWrite,
  MoveTeamMemberRecord,
  MoveTeamRecord,
} from "../repositories/interfaces/IOrganizationMoveRepository";
import type { IOrganizationRepository } from "../repositories/interfaces/IOrganizationRepository";
import type { OrganizationUrlService } from "./OrganizationUrlService";

const TEAM_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TEAM_SLUG_MAX_LENGTH = 50;

const log = logger.getSubLogger({ prefix: ["[OrganizationMoveService]"] });

export const MOVE_ERRORS = {
  usernameTaken: "username_taken_in_target_organization",
  slugTaken: "team_slug_taken_in_target_organization",
  memberUsernamesTaken: "member_usernames_taken_in_target_organization",
  userAlreadyInOrganization: "user_already_in_organization",
  teamAlreadyInOrganization: "team_already_in_organization",
  invalidUsername: "invalid_username",
  invalidSlug: "invalid_team_slug",
  usernameRequired: "user_needs_username",
  lastOwner: "last_owner_cannot_move",
} as const;

export interface IOrganizationMoveServiceDeps {
  organizationMoveRepository: IOrganizationMoveRepository;
  organizationMembershipRepository: IOrganizationMembershipRepository;
  organizationRepository: IOrganizationRepository;
  organizationUrlService: Pick<OrganizationUrlService, "getBaseUrl">;
}

export type MoveUserInput = {
  userId: number;
  toOrganizationId: number;
  newUsername?: string;
  role?: OrganizationRoleDto;
};

export type MoveUserOptions = { allowMissingUsername?: boolean };

export type MoveTeamInput = {
  teamId: number;
  toOrganizationId: number;
  newSlug?: string;
  outsideMembers: "move" | "remove";
  newUsernames?: { userId: number; username: string }[];
};

export class OrganizationMoveService {
  constructor(private readonly deps: IOrganizationMoveServiceDeps) {}

  async moveUser(
    input: MoveUserInput,
    actorUserId: number,
    options: MoveUserOptions = {}
  ): Promise<MoveUserResultDto> {
    const { userId, toOrganizationId } = input;
    const user = await this.deps.organizationMoveRepository.findUserForMove(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound("User not found");

    const organization = await this.deps.organizationRepository.findById(toOrganizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound("Organization not found");
    if (user.organizationId === toOrganizationId) {
      throw ErrorWithCode.Factory.BadRequest(MOVE_ERRORS.userAlreadyInOrganization);
    }

    const username = input.newUsername !== undefined ? this.parseUsername(input.newUsername) : user.username;
    // Org profiles are keyed by username, so a move normally cannot create one without it. Removing a
    // profile-less pending invitee from an org still has to move them to the default org, hence the opt-out.
    if (username === null && !options.allowMissingUsername) {
      throw ErrorWithCode.Factory.PreconditionFailed(MOVE_ERRORS.usernameRequired);
    }

    const fromOrganizationId = user.organizationId;
    if (fromOrganizationId !== null) await this.assertNotLastOwner(fromOrganizationId, userId);

    if (username !== null) {
      const taken = await this.deps.organizationMoveRepository.findTakenUsernames({
        organizationId: toOrganizationId,
        usernames: [username],
        excludeUserIds: [userId],
      });
      if (taken.length > 0) throw ErrorWithCode.Factory.Conflict(MOVE_ERRORS.usernameTaken);
    }

    const redirect =
      username === null
        ? null
        : await this.buildRedirect({
            fromOrganizationId,
            toOrganizationId,
            from: user.username,
            to: username,
          });

    await this.deps.organizationMoveRepository.applyMove({
      users: [
        {
          userId,
          email: user.email,
          fromOrganizationId,
          toOrganizationId,
          username,
          role: input.role ?? "MEMBER",
          keepTeamIds: [],
          redirect,
        },
      ],
    });

    log.info("organization.member.move", {
      action: "organization.member.move",
      actorUserId,
      targetUserId: userId,
      fromOrganizationId,
      organizationId: toOrganizationId,
    });

    return { userId, organizationId: toOrganizationId, username };
  }

  async previewMoveTeam(params: { teamId: number; toOrganizationId: number }): Promise<MoveTeamPreviewDto> {
    const { toOrganizationId } = params;
    const team = await this.loadTeamForMove(params.teamId, toOrganizationId);
    const outside = team.members.filter((m) => m.accepted && m.organizationId !== toOrganizationId);

    const taken = new Set(
      await this.deps.organizationMoveRepository.findTakenUsernames({
        organizationId: toOrganizationId,
        usernames: outside.flatMap((m) => (m.username === null ? [] : [m.username])),
        excludeUserIds: outside.map((m) => m.userId),
      })
    );
    const slugTaken =
      team.slug !== null &&
      (await this.deps.organizationMoveRepository.isTeamSlugTaken({
        organizationId: toOrganizationId,
        slug: team.slug,
        excludeTeamId: team.id,
      }));

    return {
      membersOutsideTarget: outside.map((m) => ({
        userId: m.userId,
        name: m.name,
        email: m.email,
        usernameTaken: m.username !== null && taken.has(m.username),
      })),
      slugTaken,
    };
  }

  async moveTeam(input: MoveTeamInput, actorUserId: number): Promise<MoveTeamResultDto> {
    const { teamId, toOrganizationId } = input;
    const newUsernameByUserId = new Map(
      (input.newUsernames ?? []).map((o) => [o.userId, this.parseUsername(o.username)])
    );
    const team = await this.loadTeamForMove(teamId, toOrganizationId);
    if (team.parentId === toOrganizationId) {
      throw ErrorWithCode.Factory.BadRequest(MOVE_ERRORS.teamAlreadyInOrganization);
    }

    const slug = input.newSlug !== undefined ? this.parseSlug(input.newSlug) : team.slug;
    if (
      slug !== null &&
      (await this.deps.organizationMoveRepository.isTeamSlugTaken({
        organizationId: toOrganizationId,
        slug,
        excludeTeamId: teamId,
      }))
    ) {
      throw ErrorWithCode.Factory.Conflict(MOVE_ERRORS.slugTaken);
    }

    const outside = team.members.filter((m) => m.organizationId !== toOrganizationId);
    // Pending invitees have not joined anything yet, so they are dropped rather than pulled into the target org
    const isMover = (m: MoveTeamMemberRecord) => input.outsideMembers === "move" && m.accepted;
    const movers = outside.filter(isMover).map((m) => {
      const targetUsername = newUsernameByUserId.get(m.userId) ?? m.username;
      if (targetUsername === null) {
        throw ErrorWithCode.Factory.PreconditionFailed(MOVE_ERRORS.usernameRequired);
      }
      return { ...m, targetUsername };
    });
    const moverIds = movers.map((m) => m.userId);
    const removeMembers = outside
      .filter((m) => !isMover(m))
      .map((m) => ({ userId: m.userId, email: m.email }));

    const usernames = movers.map((m) => m.targetUsername);
    const taken = await this.deps.organizationMoveRepository.findTakenUsernames({
      organizationId: toOrganizationId,
      usernames,
      excludeUserIds: moverIds,
    });
    if (new Set(usernames).size !== usernames.length || taken.length > 0) {
      throw ErrorWithCode.Factory.Conflict(MOVE_ERRORS.memberUsernamesTaken);
    }

    for (const mover of movers) {
      if (mover.organizationId !== null) await this.assertNotLastOwner(mover.organizationId, mover.userId);
    }

    const teamRedirect =
      slug === null
        ? null
        : await this.buildRedirect({
            fromOrganizationId: team.parentId,
            toOrganizationId,
            from: team.slug,
            to: slug,
            pathPrefix: "team/",
          });
    const users: ApplyUserMove[] = await Promise.all(
      movers.map(async (mover) => ({
        userId: mover.userId,
        email: mover.email,
        fromOrganizationId: mover.organizationId,
        toOrganizationId,
        username: mover.targetUsername,
        role: "MEMBER",
        keepTeamIds: [teamId],
        redirect: await this.buildRedirect({
          fromOrganizationId: mover.organizationId,
          toOrganizationId,
          from: mover.username,
          to: mover.targetUsername,
        }),
      }))
    );

    await this.deps.organizationMoveRepository.applyMove({
      team: { teamId, toOrganizationId, slug, removeMembers, redirect: teamRedirect },
      users,
    });

    log.info("organization.team.move", {
      action: "organization.team.move",
      actorUserId,
      targetTeamId: teamId,
      fromOrganizationId: team.parentId,
      organizationId: toOrganizationId,
      movedUserIds: moverIds,
      removedUserIds: removeMembers.map((m) => m.userId),
    });

    return { teamId, organizationId: toOrganizationId, slug };
  }

  // Instance-admin view: no org membership is required, unlike OrganizationMembershipService.listTeams
  async listTeams(params: {
    organizationId: number;
    actorUserId: number;
    search?: string;
    cursor?: number;
    limit?: number;
  }): Promise<OrganizationTeamListDto> {
    const organization = await this.deps.organizationRepository.findById(params.organizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound("Organization not found");

    const page = await this.deps.organizationMembershipRepository.listTeams({
      organizationId: params.organizationId,
      viewerUserId: params.actorUserId,
      memberUserId: undefined,
      search: params.search,
      cursor: params.cursor,
      limit: Math.min(Math.max(params.limit ?? 50, 1), 100),
    });
    return { items: page.items, nextCursor: page.nextCursor };
  }

  private async loadTeamForMove(teamId: number, toOrganizationId: number): Promise<MoveTeamRecord> {
    const team = await this.deps.organizationMoveRepository.findTeamForMove(teamId);
    // Only sub-teams of an org are movable; orgs and standalone teams are out of scope
    if (!team || team.isOrganization || team.parentId === null) {
      throw ErrorWithCode.Factory.NotFound("Team not found");
    }
    const organization = await this.deps.organizationRepository.findById(toOrganizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound("Organization not found");
    return team;
  }

  private parseSlug(value: string): string {
    const slug = slugify(value);
    if (
      !slug ||
      slug.length > TEAM_SLUG_MAX_LENGTH ||
      !TEAM_SLUG_PATTERN.test(slug) ||
      slug !== value.trim().toLowerCase()
    ) {
      throw ErrorWithCode.Factory.BadRequest(MOVE_ERRORS.invalidSlug);
    }
    return slug;
  }

  private parseUsername(value: string): string {
    const username = slugify(value);
    // Reject rather than silently rewrite so the admin sees the exact URL the user will get
    if (!username || username !== value.trim().toLowerCase()) {
      throw ErrorWithCode.Factory.BadRequest(MOVE_ERRORS.invalidUsername);
    }
    return username;
  }

  // Leaving the source org without an owner would lock its remaining members out of administration
  private async assertNotLastOwner(organizationId: number, userId: number): Promise<void> {
    const role = await this.deps.organizationMembershipRepository.findRole({ organizationId, userId });
    if (role !== "OWNER") return;
    const owners = await this.deps.organizationMembershipRepository.countOwners(organizationId);
    if (owners > 1) return;
    const members = await this.deps.organizationRepository.countMembers(organizationId);
    if (members > 1) throw ErrorWithCode.Factory.PreconditionFailed(MOVE_ERRORS.lastOwner);
  }

  private async buildRedirect(params: {
    fromOrganizationId: number | null;
    toOrganizationId: number;
    from: string | null;
    to: string;
    pathPrefix?: string;
  }): Promise<MoveRedirectWrite | null> {
    const { fromOrganizationId, toOrganizationId, from, to, pathPrefix = "" } = params;
    if (fromOrganizationId === null || from === null) return null;

    const urlService = this.deps.organizationUrlService;
    const fromBase = await urlService.getBaseUrl({ organizationId: fromOrganizationId });
    const toBase = await urlService.getBaseUrl({ organizationId: toOrganizationId });
    const toUrl = `${toBase}/${pathPrefix}${to}`;
    // Orgs sharing a base URL would otherwise get a redirect that points at itself
    if (toUrl === `${fromBase}/${pathPrefix}${from}`) return null;

    return { fromOrgId: fromOrganizationId, from, toUrl };
  }
}
