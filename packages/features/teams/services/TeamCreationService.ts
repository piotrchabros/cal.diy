import { ErrorWithCode } from "@calcom/lib/errors";
import slugify from "@calcom/lib/slugify";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";

export const TEAM_NAME_MAX_LENGTH = 100;
export const TEAM_SLUG_MAX_LENGTH = 50;
export const TEAM_BIO_MAX_LENGTH = 500;
export const TEAM_LOGO_URL_MAX_LENGTH = 2048;

const URL_SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const teamSelect = {
  id: true,
  name: true,
  slug: true,
  bio: true,
  logoUrl: true,
} satisfies Prisma.TeamSelect;

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
}

function isSupportedLogoUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://") || value.startsWith("/");
}

export class TeamCreationService {
  static normalizeSlug(rawSlug: string): string {
    return slugify(rawSlug);
  }

  static async isSlugAvailable(slug: string): Promise<boolean> {
    const normalized = TeamCreationService.normalizeSlug(slug);
    if (!normalized) {
      return false;
    }
    const existing = await prisma.team.findFirst({
      select: { id: true },
      where: { slug: normalized },
    });
    return !existing;
  }

  static async createTeam(input: CreateTeamInput): Promise<CreatedTeam> {
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
    if (logoUrl && (logoUrl.length > TEAM_LOGO_URL_MAX_LENGTH || !isSupportedLogoUrl(logoUrl))) {
      throw ErrorWithCode.Factory.BadRequest(
        "Unable to create team: team logo must be an https:// URL or an absolute path"
      );
    }

    if (!(await TeamCreationService.isSlugAvailable(slug))) {
      throw ErrorWithCode.Factory.BadRequest(
        `Unable to create team: team URL "${slug}" is already taken`
      );
    }

    const team = await prisma.team.create({
      select: teamSelect,
      data: {
        name,
        slug,
        bio,
        logoUrl,
        members: {
          create: {
            userId,
            role: MembershipRole.OWNER,
            accepted: true,
          },
        },
      },
    });

    return team;
  }
}
