import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { isLoopbackHost, normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import type {
  IOrganizationRepository,
  OrganizationRecord,
} from "../repositories/interfaces/IOrganizationRepository";
import type { OrganizationsConfig } from "../services/OrganizationService";

// The cache key comes from the client-controlled Host header, so an attacker sending random hosts
// must not be able to grow it without bound.
const MAX_ENTRIES = 1000;

type CacheEntry = { value: RequestOrganizationDto | null; expiresAt: number };

export const ORGANIZATION_DOMAIN_CACHE_TTL_MS = 60_000;

export interface IOrganizationDomainResolverDeps {
  organizationRepository: IOrganizationRepository;
  organizationsConfig: OrganizationsConfig;
}

export class OrganizationDomainResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<RequestOrganizationDto | null>>();

  constructor(private readonly deps: IOrganizationDomainResolverDeps) {}

  async resolve(host: string | null | undefined): Promise<RequestOrganizationDto | null> {
    const { defaultDomain } = this.deps.organizationsConfig;

    if (!isOrganizationsEnabled() || isLoopbackHost(host)) {
      if (defaultDomain === null) return null;
      return this.cached(`default:${defaultDomain}`, () =>
        this.deps.organizationRepository.findDefault(defaultDomain)
      );
    }

    const domain = normalizeHost(host);
    if (!domain) return null;
    return this.cached(`domain:${domain}`, () => this.deps.organizationRepository.findByDomain(domain));
  }

  private async cached(
    key: string,
    load: () => Promise<OrganizationRecord | null>
  ): Promise<RequestOrganizationDto | null> {
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = load()
      .then((record) => {
        const value = record ? this.toDto(record) : null;
        // Misses are cached too, otherwise every request for an unknown host would hit the database.
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, lookup);
    return lookup;
  }

  private store(key: string, value: RequestOrganizationDto | null): void {
    this.cache.delete(key);
    if (this.cache.size >= MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ORGANIZATION_DOMAIN_CACHE_TTL_MS });
  }

  private toDto(record: OrganizationRecord): RequestOrganizationDto {
    const { defaultDomain } = this.deps.organizationsConfig;
    return {
      id: record.id,
      slug: record.slug,
      domain: record.domain,
      isDefault: defaultDomain !== null && record.domain === defaultDomain,
    };
  }
}
