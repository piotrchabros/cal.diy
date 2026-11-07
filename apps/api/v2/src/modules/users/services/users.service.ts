import type { User } from "@calcom/prisma/client";
import { Injectable } from "@nestjs/common";
import { isOrganizationProfileActive, isOrganizationsEnabled } from "@/lib/organizations-enabled";
import { UsersRepository, UserWithProfile } from "@/modules/users/users.repository";

export type ProfileMinimal = {
  id: number;
  username?: string | null;
  organizationId: number | null;
  organization: {
    id: number;
    slug?: string | null;
    isPlatform: boolean;
  } | null;
};

export type UserWithProfileMinimal = {
  organizationId?: number | null;
  movedToProfile?: ProfileMinimal | null;
  profiles?: ProfileMinimal[];
};

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async getByUsernames(usernames: string[], orgSlug?: string, orgId?: number) {
    const users = await Promise.all(
      usernames.map((username) => this.usersRepository.findByUsername(username, orgSlug, orgId))
    );

    return users;
  }

  getUserMainProfile(user: UserWithProfileMinimal): ProfileMinimal | undefined {
    const movedToProfile = isOrganizationProfileActive(user?.movedToProfile) ? user.movedToProfile : null;
    const profiles = user.profiles?.filter((p) => isOrganizationProfileActive(p));
    return movedToProfile || profiles?.find((p) => p.organizationId === user.organizationId) || profiles?.[0];
  }

  getUserMainOrgId(user: UserWithProfileMinimal): number | null {
    // With organizations off users.organizationId points at BlueBee after the switch-over (spec 005, T324)
    if (!isOrganizationsEnabled()) {
      return this.getUserMainProfile(user)?.organizationId ?? null;
    }
    return this.getUserMainProfile(user)?.organizationId ?? user.organizationId ?? null;
  }

  getUserProfileByOrgId(user: UserWithProfile, organizationId: number) {
    return user.profiles?.find((p) => p.organizationId === organizationId);
  }
}
