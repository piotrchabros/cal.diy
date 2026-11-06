import type {
  OrganizationDto,
  OrganizationListItemDto,
  OrganizationListResultDto,
} from "@calcom/lib/dto/OrganizationDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import { normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import type {
  IOrganizationRepository,
  OrganizationListItemRecord,
  OrganizationRecord,
} from "../repositories/interfaces/IOrganizationRepository";

// Requires a dotted hostname ending in a letter-led TLD, which rules out IPs, localhost and URLs
const ORGANIZATION_DOMAIN_REGEX =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_NAME_LENGTH = 100;
const MIN_SLUG_LENGTH = 2;

export type OrganizationsConfig = { defaultDomain: string | null };

export interface IOrganizationServiceDeps {
  organizationRepository: IOrganizationRepository;
  organizationsConfig: OrganizationsConfig;
}

export type CreateOrganizationInput = { name: string; slug: string; domain: string };

export type UpdateOrganizationInput = { name?: string; slug?: string; domain?: string };

export const ORGANIZATION_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class OrganizationService {
  constructor(private readonly deps: IOrganizationServiceDeps) {}

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

  async create(input: CreateOrganizationInput): Promise<OrganizationDto> {
    const name = this.parseName(input.name);
    const slug = this.parseSlug(input.slug);
    const domain = this.parseDomain(input.domain);

    await this.assertSlugAvailable(slug, null);
    await this.assertDomainAvailable(domain, null);

    const record = await this.deps.organizationRepository.create({ name, slug, domain });
    return this.toDto(record);
  }

  async update(id: number, input: UpdateOrganizationInput): Promise<OrganizationDto> {
    const existing = await this.findByIdOrThrow(id);

    const name = input.name === undefined ? undefined : this.parseName(input.name);
    const slug = input.slug === undefined ? undefined : this.parseSlug(input.slug);
    const domain = input.domain === undefined ? undefined : this.parseDomain(input.domain);

    // The default org owns the app's own domain; loopback and invitation-less sign-ups resolve to it,
    // so moving it elsewhere would leave those requests without an organization
    if (domain !== undefined && this.isDefault(existing) && domain !== existing.domain) {
      throw ErrorWithCode.Factory.PreconditionFailed("The default organization's domain cannot be changed");
    }

    if (slug !== undefined) await this.assertSlugAvailable(slug, id);
    if (domain !== undefined) await this.assertDomainAvailable(domain, id);

    const updated = await this.deps.organizationRepository.update(id, { name, slug, domain });
    if (!updated) throw ErrorWithCode.Factory.NotFound("Organization not found");
    return this.toDto(updated);
  }

  async delete(id: number): Promise<{ id: number }> {
    const existing = await this.findByIdOrThrow(id);

    if (this.isDefault(existing)) {
      throw ErrorWithCode.Factory.PreconditionFailed("The default organization cannot be deleted");
    }

    const [memberCount, teamCount] = await Promise.all([
      this.deps.organizationRepository.countMembers(id),
      this.deps.organizationRepository.countTeams(id),
    ]);
    if (memberCount > 0 || teamCount > 0) {
      throw ErrorWithCode.Factory.PreconditionFailed(
        "Move the organization's members and teams out before deleting it"
      );
    }

    const deleted = await this.deps.organizationRepository.delete(id);
    if (!deleted) throw ErrorWithCode.Factory.NotFound("Organization not found");
    return deleted;
  }

  private async findByIdOrThrow(id: number): Promise<OrganizationRecord> {
    const record = await this.deps.organizationRepository.findById(id);
    if (!record) throw ErrorWithCode.Factory.NotFound("Organization not found");
    return record;
  }

  private parseName(input: string): string {
    const name = input.trim();
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      throw ErrorWithCode.Factory.BadRequest(
        `Organization name must be between 1 and ${MAX_NAME_LENGTH} characters`
      );
    }
    return name;
  }

  private parseSlug(input: string): string {
    const slug = input.trim().toLowerCase();
    if (slug.length < MIN_SLUG_LENGTH || !ORGANIZATION_SLUG_REGEX.test(slug)) {
      throw ErrorWithCode.Factory.BadRequest(
        "Organization slug must be 2-63 lowercase letters, digits or hyphens and cannot start or end with a hyphen"
      );
    }
    return slug;
  }

  private parseDomain(input: string): string {
    const domain = normalizeHost(input);
    if (!domain || !ORGANIZATION_DOMAIN_REGEX.test(domain)) {
      throw ErrorWithCode.Factory.BadRequest("Organization domain must be a valid hostname such as acme.com");
    }
    return domain;
  }

  private async assertSlugAvailable(slug: string, ownId: number | null): Promise<void> {
    const existing = await this.deps.organizationRepository.findBySlug(slug);
    if (existing && existing.id !== ownId) {
      throw ErrorWithCode.Factory.Conflict("Organization slug is already taken");
    }
  }

  private async assertDomainAvailable(domain: string, ownId: number | null): Promise<void> {
    const existing = await this.deps.organizationRepository.findByDomain(domain);
    if (existing && existing.id !== ownId) {
      throw ErrorWithCode.Factory.Conflict("Organization domain is already taken");
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
