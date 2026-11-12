import type { PrismaTempOrgRedirectRepository } from "@calcom/features/organizations/repositories/PrismaTempOrgRedirectRepository";
import { TEAM_LOGO_DATA_URL_PATTERN } from "@calcom/features/teams/lib/teamProfileSchema";
import type { UploadTeamLogo } from "@calcom/features/teams/lib/uploadTeamLogo";
import { defaultUploadTeamLogo } from "@calcom/features/teams/lib/uploadTeamLogo";
import type { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { ErrorWithCode } from "@calcom/lib/errors";
import slugify from "@calcom/lib/slugify";

export const TEAM_NAME_MAX_LENGTH = 100;
export const TEAM_SLUG_MAX_LENGTH = 50;
export const TEAM_BIO_MAX_LENGTH = 500;

const URL_SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type CreatedTeam = {
  id: number;
  name: string;
  slug: string | null;
  bio: string | null;
  logoUrl: string | null;
};

export interface CreateTeamInput {
  userId: number;
  name: string;
  slug: string;
  bio?: string;
  logoUrl?: string | null;
  organizationId?: number | null;
}

function isSupportedLogoUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://") || value.startsWith("/");
}

export interface ITeamCreationServiceDeps {
  teamRepo: Pick<TeamRepository, "findIdBySlug" | "createWithOwner" | "updateLogoUrl">;
  tempOrgRedirectRepo: Pick<PrismaTempOrgRedirectRepository, "disableByFrom">;
}

export class TeamCreationService {
  constructor(
    private readonly deps: ITeamCreationServiceDeps,
    private readonly uploadTeamLogo: UploadTeamLogo = defaultUploadTeamLogo
  ) {}

  static normalizeSlug(rawSlug: string): string {
    return slugify(rawSlug);
  }

  async isSlugAvailable(slug: string, organizationId?: number | null): Promise<boolean> {
    const normalized = TeamCreationService.normalizeSlug(slug);
    if (!normalized) {
      return false;
    }
    // Without an organization the slug is checked against every team.
    const existing = await this.deps.teamRepo.findIdBySlug({
      slug: normalized,
      parentId: organizationId ?? undefined,
    });
    return !existing;
  }

  async createTeam(input: CreateTeamInput): Promise<CreatedTeam> {
    const { userId } = input;
    const name = input.name.trim();
    const slug = TeamCreationService.normalizeSlug(input.slug);
    const bio = input.bio?.trim() ? input.bio.trim() : null;
    const logoUrl = input.logoUrl?.trim() ? input.logoUrl.trim() : null;

    if (!name) {
      throw ErrorWithCode.Factory.BadRequest("Unable to create team: team name is required");
    }
    if (name.length > TEAM_NAME_MAX_LENGTH) {
      throw ErrorWithCode.Factory.BadRequest(
        `Unable to create team: team name must be ${TEAM_NAME_MAX_LENGTH} characters or fewer`
      );
    }
    if (!slug) {
      throw ErrorWithCode.Factory.BadRequest(
        "Unable to create team: team URL is required and must contain URL-safe characters"
      );
    }
    if (slug.length > TEAM_SLUG_MAX_LENGTH) {
      throw ErrorWithCode.Factory.BadRequest(
        `Unable to create team: team URL must be ${TEAM_SLUG_MAX_LENGTH} characters or fewer`
      );
    }
    if (!URL_SAFE_SLUG_PATTERN.test(slug)) {
      throw ErrorWithCode.Factory.BadRequest(
        `Unable to create team: team URL "${slug}" may only contain lowercase letters, numbers, and dashes`
      );
    }
    if (bio && bio.length > TEAM_BIO_MAX_LENGTH) {
      throw ErrorWithCode.Factory.BadRequest(
        `Unable to create team: team bio must be ${TEAM_BIO_MAX_LENGTH} characters or fewer`
      );
    }
    if (logoUrl && !TEAM_LOGO_DATA_URL_PATTERN.test(logoUrl) && !isSupportedLogoUrl(logoUrl)) {
      throw ErrorWithCode.Factory.BadRequest(
        "Unable to create team: team logo must be an https:// URL, an absolute path, or an uploaded image"
      );
    }

    if (!(await this.isSlugAvailable(slug, input.organizationId))) {
      throw ErrorWithCode.Factory.BadRequest(`Unable to create team: team URL "${slug}" is already taken`);
    }

    const logoIsDataUrl = !!logoUrl && TEAM_LOGO_DATA_URL_PATTERN.test(logoUrl);

    const team = await this.deps.teamRepo.createWithOwner({
      name,
      slug,
      bio,
      logoUrl: logoIsDataUrl ? null : logoUrl,
      parentId: input.organizationId ?? null,
      ownerUserId: userId,
    });

    if (logoIsDataUrl && logoUrl) {
      // Mirror the team-profile update flow: data URLs are uploaded and only the hosted URL is stored.
      const storedUrl = await this.uploadTeamLogo({ teamId: team.id, logo: logoUrl });
      await this.deps.teamRepo.updateLogoUrl({ teamId: team.id, logoUrl: storedUrl });
      return { ...team, logoUrl: storedUrl };
    }

    // A slug freed by a team move may still redirect to the moved team; the new team wins
    if (input.organizationId != null) {
      await this.deps.tempOrgRedirectRepo.disableByFrom({
        fromOrgId: input.organizationId,
        from: slug,
        types: ["Team", "TeamEventType"],
      });
    }

    return team;
  }
}
