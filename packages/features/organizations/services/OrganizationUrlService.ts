import { WEBAPP_URL } from "@calcom/lib/constants";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { isLoopbackHost, normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import type { IOrganizationMembershipRepository } from "../repositories/interfaces/IOrganizationMembershipRepository";
import type { IOrganizationRepository } from "../repositories/interfaces/IOrganizationRepository";
import type { OrganizationsConfig } from "./OrganizationService";

const MAX_ENTRIES = 1000;

type CacheEntry = { value: string; expiresAt: number };

export const ORGANIZATION_URL_CACHE_TTL_MS = 60_000;

export interface IOrganizationUrlServiceDeps {
  organizationRepository: IOrganizationRepository;
  organizationMembershipRepository: IOrganizationMembershipRepository;
  organizationsConfig: OrganizationsConfig;
}

export class OrganizationUrlService {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inFlight = new Map<number, Promise<string>>();

  constructor(private readonly deps: IOrganizationUrlServiceDeps) {}

  async getBaseUrl({ organizationId }: { organizationId: number | null | undefined }): Promise<string> {
    if (!isOrganizationsEnabled()) return WEBAPP_URL;
    if (organizationId === null || organizationId === undefined) return WEBAPP_URL;
    return this.cached(organizationId);
  }

  async getBaseUrlForUser({ userId }: { userId: number | null | undefined }): Promise<string> {
    if (!isOrganizationsEnabled()) return WEBAPP_URL;
    if (userId === null || userId === undefined) return WEBAPP_URL;
    const user = await this.deps.organizationMembershipRepository.findUserById(userId);
    return this.getBaseUrl({ organizationId: user?.organizationId });
  }

  async getBaseUrlForEmail({ email }: { email: string | null | undefined }): Promise<string> {
    if (!isOrganizationsEnabled()) return WEBAPP_URL;
    if (!email) return WEBAPP_URL;
    const user = await this.deps.organizationMembershipRepository.findUserByEmail(email);
    return this.getBaseUrl({ organizationId: user?.organizationId });
  }

  async getBaseUrlForTeam({ teamId }: { teamId: number | null | undefined }): Promise<string> {
    if (!isOrganizationsEnabled()) return WEBAPP_URL;
    if (teamId === null || teamId === undefined) return WEBAPP_URL;
    const team = await this.deps.organizationRepository.findTeamParentById(teamId);
    if (!team) return WEBAPP_URL;
    const organizationId = team.parentId ?? (team.isOrganization ? team.id : null);
    return this.getBaseUrl({ organizationId });
  }

  private async cached(organizationId: number): Promise<string> {
    const entry = this.cache.get(organizationId);
    if (entry && entry.expiresAt > Date.now()) return entry.value;

    const pending = this.inFlight.get(organizationId);
    if (pending) return pending;

    const lookup = this.load(organizationId)
      .then((value) => {
        this.store(organizationId, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(organizationId);
      });

    this.inFlight.set(organizationId, lookup);
    return lookup;
  }

  private async load(organizationId: number): Promise<string> {
    const domain = normalizeHost(await this.deps.organizationRepository.findDomainById(organizationId));
    // WEBAPP_URL keeps the configured protocol and port, which a bare https://<domain> would lose
    // for the default org and for local development.
    if (!domain || domain === this.deps.organizationsConfig.defaultDomain || isLoopbackHost(domain)) {
      return WEBAPP_URL;
    }
    return `https://${domain}`;
  }

  private store(organizationId: number, value: string): void {
    this.cache.delete(organizationId);
    if (this.cache.size >= MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(organizationId, { value, expiresAt: Date.now() + ORGANIZATION_URL_CACHE_TTL_MS });
  }
}
