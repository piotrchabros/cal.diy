jest.mock(
  "@calcom/platform-libraries",
  () => ({
    CreationSource: {},
  }),
  { virtual: true }
);

import type { ProfileMinimal, UserWithProfileMinimal } from "./users.service";
import { UsersService } from "./users.service";
import type { UsersRepository } from "@/modules/users/users.repository";

const BLUEBEE_ORG_ID = 1;
const PLATFORM_ORG_ID = 2;

const blueBeeProfile: ProfileMinimal = {
  id: 10,
  username: "alice",
  organizationId: BLUEBEE_ORG_ID,
  organization: { id: BLUEBEE_ORG_ID, slug: "bluebee", isPlatform: false },
};

const platformProfile: ProfileMinimal = {
  id: 20,
  username: "managed",
  organizationId: PLATFORM_ORG_ID,
  organization: { id: PLATFORM_ORG_ID, slug: "platform", isPlatform: true },
};

describe("UsersService main profile", () => {
  const originalFlag = process.env.ORGANIZATIONS_ENABLED;
  let service: UsersService;

  beforeEach(() => {
    service = new UsersService({} as unknown as UsersRepository);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ORGANIZATIONS_ENABLED;
    } else {
      process.env.ORGANIZATIONS_ENABLED = originalFlag;
    }
  });

  describe("organizations disabled", () => {
    beforeEach(() => {
      process.env.ORGANIZATIONS_ENABLED = "";
    });

    it("ignores the switch-over BlueBee profile and organization", () => {
      const user: UserWithProfileMinimal = {
        organizationId: BLUEBEE_ORG_ID,
        movedToProfile: blueBeeProfile,
        profiles: [blueBeeProfile],
      };

      expect(service.getUserMainProfile(user)).toBeUndefined();
      expect(service.getUserMainOrgId(user)).toBeNull();
    });

    it("keeps platform organization profiles", () => {
      const user: UserWithProfileMinimal = {
        organizationId: PLATFORM_ORG_ID,
        movedToProfile: platformProfile,
        profiles: [platformProfile],
      };

      expect(service.getUserMainProfile(user)).toBe(platformProfile);
      expect(service.getUserMainOrgId(user)).toBe(PLATFORM_ORG_ID);
    });

    it("picks the platform profile over the BlueBee one", () => {
      const user: UserWithProfileMinimal = {
        organizationId: BLUEBEE_ORG_ID,
        profiles: [blueBeeProfile, platformProfile],
      };

      expect(service.getUserMainProfile(user)).toBe(platformProfile);
      expect(service.getUserMainOrgId(user)).toBe(PLATFORM_ORG_ID);
    });
  });

  describe("organizations enabled", () => {
    beforeEach(() => {
      process.env.ORGANIZATIONS_ENABLED = "true";
    });

    it("returns the BlueBee profile and organization", () => {
      const user: UserWithProfileMinimal = {
        organizationId: BLUEBEE_ORG_ID,
        movedToProfile: blueBeeProfile,
        profiles: [blueBeeProfile],
      };

      expect(service.getUserMainProfile(user)).toBe(blueBeeProfile);
      expect(service.getUserMainOrgId(user)).toBe(BLUEBEE_ORG_ID);
    });

    it("prefers the profile matching user.organizationId", () => {
      const user: UserWithProfileMinimal = {
        organizationId: PLATFORM_ORG_ID,
        profiles: [blueBeeProfile, platformProfile],
      };

      expect(service.getUserMainProfile(user)).toBe(platformProfile);
    });

    it("falls back to user.organizationId without profiles", () => {
      const user: UserWithProfileMinimal = { organizationId: BLUEBEE_ORG_ID, profiles: [] };

      expect(service.getUserMainProfile(user)).toBeUndefined();
      expect(service.getUserMainOrgId(user)).toBe(BLUEBEE_ORG_ID);
    });
  });
});
