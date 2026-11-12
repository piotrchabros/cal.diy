import { TEAM_LOGO_DATA_URL_PATTERN } from "@calcom/features/teams/lib/teamProfileSchema";
import type { UploadTeamLogo } from "@calcom/features/teams/lib/uploadTeamLogo";
import { defaultUploadTeamLogo } from "@calcom/features/teams/lib/uploadTeamLogo";
import type {
  CurrentOrganizationDto,
  OrganizationDto,
  OrganizationListItemDto,
  OrganizationListResultDto,
} from "@calcom/lib/dto/OrganizationDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import { ORGANIZATION_ERRORS } from "../lib/organizationErrors";
import type {
  IOrganizationRepository,
  OrganizationListItemRecord,
  OrganizationRecord,
} from "../repositories/interfaces/IOrganizationRepository";
import type { OrganizationMembershipService } from "./OrganizationMembershipService";
import type { OrganizationMoveService } from "./OrganizationMoveService";

const log = logger.getSubLogger({ prefix: ["[OrganizationService]"] });

// Requires a dotted hostname ending in a letter-led TLD, which rules out IPs, localhost and URLs
const ORGANIZATION_DOMAIN_REGEX =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_NAME_LENGTH = 100;
const MIN_SLUG_LENGTH = 2;
const DEFAULT_ORGANIZATION_NAME = "Default";
const DEFAULT_ORGANIZATION_SLUG = "default";
const DEFAULT_ORGANIZATION_FALLBACK_SLUG = "default-organization";

type ResolvedOwner = { kind: "user"; userId: number } | { kind: "invite"; email: string };

export type OrganizationsConfig = { defaultDomain: string | null };

export interface IOrganizationServiceDeps {
  organizationRepository: IOrganizationRepository;
  organizationsConfig: OrganizationsConfig;
  organizationMembershipService: OrganizationMembershipService;
  organizationMoveService: Pick<OrganizationMoveService, "moveUser">;
}

export type OrganizationOwnerInput = { userId: number } | { email: string };

export type CreateOrganizationInput = {
  name: string;
  slug: string;
  domain: string;
  owner: OrganizationOwnerInput;
  confirmMoveOwner?: boolean;
};

export type UpdateOrganizationInput = { name?: string; slug?: string; domain?: string; ownerUserId?: number };

export const ORGANIZATION_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class OrganizationService {
  constructor(
    private readonly deps: IOrganizationServiceDeps,
    private readonly uploadLogo: UploadTeamLogo = defaultUploadTeamLogo
  ) {}

  async list(params: {
    search?: string;
    cursor?: number;
    limit?: number;
  }): Promise<OrganizationListResultDto> {
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const page = await this.deps.organizationRepository.list({
      search: params.search,
      cursor: params.cursor,
      limit,
    });
    return {
      items: page.items.map((item) => this.toListItemDto(item)),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: number): Promise<OrganizationDto> {
    const record = await this.findByIdOrThrow(id);
    return this.toDto(record);
  }

  async getForMember(params: {
    organizationId: number;
    viewerUserId: number;
  }): Promise<CurrentOrganizationDto> {
    const { organizationId, viewerUserId } = params;
    const viewerRole = await this.deps.organizationMembershipService.getRole(viewerUserId, organizationId);
    if (viewerRole === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const {
      memberCount: _memberCount,
      teamCount: _teamCount,
      ...organization
    } = this.toDto(await this.findByIdOrThrow(organizationId));
    return { ...organization, viewerRole };
  }

  async getDefault(): Promise<OrganizationDto> {
    const { defaultDomain } = this.deps.organizationsConfig;
    if (!defaultDomain) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.defaultNotFound);
    const record = await this.deps.organizationRepository.findDefault(defaultDomain);
    if (!record) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.defaultNotFound);
    return this.toDto(record);
  }

  // Bypasses create()'s domain validation on purpose: a fresh install's own host is often localhost or
  // localhost:3000, and its first admin needs this organization before anyone can own it
  async ensureDefault(): Promise<OrganizationDto> {
    const { defaultDomain } = this.deps.organizationsConfig;
    if (!defaultDomain) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.defaultRequiresHost);
    }

    const existing = await this.deps.organizationRepository.findDefault(defaultDomain);
    if (existing) return this.toDto(existing);

    const slugTaken = await this.deps.organizationRepository.findBySlug(DEFAULT_ORGANIZATION_SLUG);
    const slug = slugTaken ? DEFAULT_ORGANIZATION_FALLBACK_SLUG : DEFAULT_ORGANIZATION_SLUG;

    let record: OrganizationRecord;
    try {
      record = await this.deps.organizationRepository.create({
        name: DEFAULT_ORGANIZATION_NAME,
        slug,
        domain: defaultDomain,
      });
    } catch (error) {
      // A concurrent setup request may have created it between the lookup and the insert
      const created = await this.deps.organizationRepository.findDefault(defaultDomain);
      if (created) return this.toDto(created);
      throw error;
    }

    log.info("organization.default.create", {
      action: "organization.default.create",
      organizationId: record.id,
    });

    return this.toDto(record);
  }

  async create(
    input: CreateOrganizationInput,
    actorUserId: number,
    actorName?: string | null
  ): Promise<OrganizationDto> {
    const name = this.parseName(input.name);
    const slug = this.parseSlug(input.slug);
    const domain = this.parseDomain(input.domain);

    await this.assertSlugAvailable(slug, null);
    await this.assertDomainAvailable(domain, null);
    const owner = await this.resolveOwner(input.owner);
    if (owner.kind === "user") await this.assertOwnerEligible(owner.userId, input.confirmMoveOwner ?? false);
    // FR-023: logs carry ids only, so an invited owner is flagged rather than identified by email
    const ownerLogFields = owner.kind === "user" ? { ownerUserId: owner.userId } : { invitedOwner: true };

    const record = await this.deps.organizationRepository.create({ name, slug, domain });

    try {
      if (owner.kind === "invite") {
        await this.deps.organizationMembershipService.inviteOwner({
          organizationId: record.id,
          email: owner.email,
          inviterName: actorName?.trim() || name,
        });
      } else {
        await this.deps.organizationMoveService.moveUser(
          { userId: owner.userId, toOrganizationId: record.id, role: "OWNER" },
          actorUserId
        );
      }
    } catch (error) {
      // Keep an organization from existing without an owner when a race slips past the pre-check
      try {
        await this.deps.organizationRepository.delete(record.id);
      } catch (cleanupError) {
        log.error("Failed to remove an organization whose owner could not be added", {
          organizationId: record.id,
          ...ownerLogFields,
          cleanupError,
        });
      }
      throw error;
    }

    log.info("organization.create", {
      action: "organization.create",
      actorUserId,
      organizationId: record.id,
      ...ownerLogFields,
    });

    return this.get(record.id);
  }

  async update(id: number, input: UpdateOrganizationInput, actorUserId: number): Promise<OrganizationDto> {
    const existing = await this.findByIdOrThrow(id);

    const name = input.name === undefined ? undefined : this.parseName(input.name);
    const slug = input.slug === undefined ? undefined : this.parseSlug(input.slug);
    const domain = input.domain === undefined ? undefined : this.parseDomain(input.domain);

    // The default org owns the app's own domain; loopback and invitation-less sign-ups resolve to it,
    // so moving it elsewhere would leave those requests without an organization
    if (domain !== undefined && this.isDefault(existing) && domain !== existing.domain) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.defaultDomainLocked);
    }

    if (slug !== undefined) await this.assertSlugAvailable(slug, id);
    if (domain !== undefined) await this.assertDomainAvailable(domain, id);

    // Granted before the field write so a refused owner leaves the rest of the edit unapplied
    if (input.ownerUserId !== undefined) {
      await this.deps.organizationMembershipService.grantOwner({
        organizationId: id,
        userId: input.ownerUserId,
        actorUserId,
      });
    }

    const updated = await this.deps.organizationRepository.update(id, { name, slug, domain });
    if (!updated) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const changed = Object.entries({ name, slug, domain, owner: input.ownerUserId })
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    log.info("organization.update", {
      action: "organization.update",
      actorUserId,
      organizationId: id,
      changed,
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
    });

    // Re-read so the returned owner list is guaranteed to include the owner just granted
    if (input.ownerUserId !== undefined) return this.get(id);
    return this.toDto(updated);
  }

  // Org owners/admins rename their own organization from the settings panel. Slug, domain, owner
  // and deletion stay instance-admin-only, so the name is the only field writable here (FR-024)
  async updateName(params: {
    organizationId: number;
    actorUserId: number;
    name: string;
  }): Promise<OrganizationDto> {
    const { organizationId, actorUserId } = params;
    const role = await this.deps.organizationMembershipService.getRole(actorUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization);
    }

    const name = this.parseName(params.name);
    const updated = await this.deps.organizationRepository.update(organizationId, { name });
    if (!updated) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    log.info("organization.updateName", {
      action: "organization.updateName",
      actorUserId,
      organizationId,
    });
    return this.toDto(updated);
  }

  async updateLogo(params: {
    organizationId: number;
    actorUserId: number;
    logo: string | null;
  }): Promise<OrganizationDto> {
    const { organizationId, actorUserId, logo } = params;
    const role = await this.deps.organizationMembershipService.getRole(actorUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization);
    }

    if (logo !== null && !TEAM_LOGO_DATA_URL_PATTERN.test(logo)) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.logoInvalid);
    }
    const logoUrl = logo === null ? null : await this.uploadLogo({ teamId: organizationId, logo });

    const updated = await this.deps.organizationRepository.update(organizationId, { logoUrl });
    if (!updated) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    log.info("organization.updateLogo", {
      action: "organization.updateLogo",
      actorUserId,
      organizationId,
    });
    return this.toDto(updated);
  }

  // Removing an owner keeps them in the organization with a lesser role; the last owner cannot be demoted
  async demoteOwner(
    id: number,
    input: { userId: number; role: "ADMIN" | "MEMBER" },
    actorUserId: number
  ): Promise<OrganizationDto> {
    await this.findByIdOrThrow(id);
    await this.deps.organizationMembershipService.demoteOwner({
      organizationId: id,
      userId: input.userId,
      role: input.role,
      actorUserId,
    });
    return this.get(id);
  }

  async delete(id: number, actorUserId: number): Promise<{ id: number }> {
    const existing = await this.findByIdOrThrow(id);

    if (this.isDefault(existing)) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.defaultCannotBeDeleted);
    }

    const [memberCount, teamCount] = await Promise.all([
      this.deps.organizationRepository.countMembers(id),
      this.deps.organizationRepository.countTeams(id),
    ]);
    if (memberCount > 0 || teamCount > 0) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.notEmpty);
    }

    const deleted = await this.deps.organizationRepository.delete(id);
    if (!deleted) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    log.info("organization.delete", { action: "organization.delete", actorUserId, organizationId: id });

    return deleted;
  }

  private async resolveOwner(owner: OrganizationOwnerInput): Promise<ResolvedOwner> {
    if ("userId" in owner) return { kind: "user", userId: owner.userId };

    const email = owner.email.trim().toLowerCase();
    if (!email.includes("@")) throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.ownerEmailInvalid);

    const candidate = await this.deps.organizationMembershipService.findMembershipCandidateByEmail(email);
    return candidate ? { kind: "user", userId: candidate.id } : { kind: "invite", email };
  }

  // Every user already belongs to an organization, so an existing owner is always moved into the new one
  private async assertOwnerEligible(userId: number, confirmMoveOwner: boolean): Promise<void> {
    const candidate = await this.deps.organizationMembershipService.findMembershipCandidate(userId);
    if (!candidate) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.ownerNotFound);

    if (candidate.username === null) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.ownerNeedsUsername);
    }

    // Stable code-like message so the admin UI can recognise it and ask for confirmation
    if (!confirmMoveOwner) {
      throw ErrorWithCode.Factory.PreconditionFailed(ORGANIZATION_ERRORS.ownerInAnotherOrganization);
    }
  }

  private async findByIdOrThrow(id: number): Promise<OrganizationRecord> {
    const record = await this.deps.organizationRepository.findById(id);
    if (!record) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    return record;
  }

  private parseName(input: string): string {
    const name = input.trim();
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.nameInvalid);
    }
    return name;
  }

  private parseSlug(input: string): string {
    const slug = input.trim().toLowerCase();
    if (slug.length < MIN_SLUG_LENGTH || !ORGANIZATION_SLUG_REGEX.test(slug)) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.slugInvalid);
    }
    return slug;
  }

  private parseDomain(input: string): string {
    const domain = normalizeHost(input);
    if (!domain || !ORGANIZATION_DOMAIN_REGEX.test(domain)) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_ERRORS.domainInvalid);
    }
    return domain;
  }

  private async assertSlugAvailable(slug: string, ownId: number | null): Promise<void> {
    const existing = await this.deps.organizationRepository.findBySlug(slug);
    if (existing && existing.id !== ownId) {
      throw ErrorWithCode.Factory.Conflict(ORGANIZATION_ERRORS.slugTaken);
    }
  }

  private async assertDomainAvailable(domain: string, ownId: number | null): Promise<void> {
    const existing = await this.deps.organizationRepository.findByDomain(domain);
    if (existing && existing.id !== ownId) {
      throw ErrorWithCode.Factory.Conflict(ORGANIZATION_ERRORS.domainTaken);
    }
  }

  private isDefault(record: { domain: string | null }): boolean {
    const { defaultDomain } = this.deps.organizationsConfig;
    return defaultDomain !== null && record.domain === defaultDomain;
  }

  private toListItemDto(record: OrganizationListItemRecord): OrganizationListItemDto {
    return { ...record, isDefault: this.isDefault(record) };
  }

  private toDto(record: OrganizationRecord): OrganizationDto {
    return { ...record, isDefault: this.isDefault(record) };
  }
}
