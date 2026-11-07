import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import type { MoveUserResultDto } from "@calcom/lib/dto/OrganizationMoveDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { slugify } from "@calcom/lib/slugify";
import type { IOrganizationMembershipRepository } from "../repositories/interfaces/IOrganizationMembershipRepository";
import type {
  IOrganizationMoveRepository,
  MoveRedirectWrite,
} from "../repositories/interfaces/IOrganizationMoveRepository";
import type { IOrganizationRepository } from "../repositories/interfaces/IOrganizationRepository";
import type { OrganizationUrlService } from "./OrganizationUrlService";

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

export class OrganizationMoveService {
  constructor(private readonly deps: IOrganizationMoveServiceDeps) {}

  async moveUser(input: MoveUserInput, actorUserId: number): Promise<MoveUserResultDto> {
    const { userId, toOrganizationId } = input;
    const user = await this.deps.organizationMoveRepository.findUserForMove(userId);
    if (!user) throw ErrorWithCode.Factory.NotFound("User not found");

    const organization = await this.deps.organizationRepository.findById(toOrganizationId);
    if (!organization) throw ErrorWithCode.Factory.NotFound("Organization not found");
    if (user.organizationId === toOrganizationId) {
      throw ErrorWithCode.Factory.BadRequest(MOVE_ERRORS.userAlreadyInOrganization);
    }

    const username = input.newUsername !== undefined ? this.parseUsername(input.newUsername) : user.username;
    // Org profiles are keyed by username, so the move cannot create one without it
    if (username === null) throw ErrorWithCode.Factory.PreconditionFailed(MOVE_ERRORS.usernameRequired);

    const fromOrganizationId = user.organizationId;
    if (fromOrganizationId !== null) await this.assertNotLastOwner(fromOrganizationId, userId);

    const taken = await this.deps.organizationMoveRepository.findTakenUsernames({
      organizationId: toOrganizationId,
      usernames: [username],
      excludeUserIds: [userId],
    });
    if (taken.length > 0) throw ErrorWithCode.Factory.Conflict(MOVE_ERRORS.usernameTaken);

    const redirect = await this.buildRedirect({
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
  }): Promise<MoveRedirectWrite | null> {
    const { fromOrganizationId, toOrganizationId, from, to } = params;
    if (fromOrganizationId === null || from === null) return null;

    const urlService = this.deps.organizationUrlService;
    const fromBase = await urlService.getBaseUrl({ organizationId: fromOrganizationId });
    const toBase = await urlService.getBaseUrl({ organizationId: toOrganizationId });
    const toUrl = `${toBase}/${to}`;
    // Orgs sharing a base URL would otherwise get a redirect that points at itself
    if (toUrl === `${fromBase}/${from}`) return null;

    return { fromOrgId: fromOrganizationId, from, toUrl };
  }
}
