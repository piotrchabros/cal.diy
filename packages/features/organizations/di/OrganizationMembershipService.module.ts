import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as teamInviteServiceModuleLoader } from "@calcom/features/membership/di/TeamInviteService.module";
import { OrganizationMembershipService } from "@calcom/features/organizations/services/OrganizationMembershipService";
import { moduleLoader as organizationsConfigModuleLoader } from "./OrganizationsConfig.module";
import { moduleLoader as organizationMembershipRepositoryModuleLoader } from "./PrismaOrganizationMembershipRepository.module";
import { moduleLoader as organizationRepositoryModuleLoader } from "./PrismaOrganizationRepository.module";
import { moduleLoader as tempOrgRedirectRepositoryModuleLoader } from "./PrismaTempOrgRedirectRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_MEMBERSHIP_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_MEMBERSHIP_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationMembershipService,
  depsMap: {
    organizationMembershipRepository: organizationMembershipRepositoryModuleLoader,
    organizationRepository: organizationRepositoryModuleLoader,
    organizationsConfig: organizationsConfigModuleLoader,
    userRepository: userRepositoryModuleLoader,
    teamInviteService: teamInviteServiceModuleLoader,
    tempOrgRedirectRepository: tempOrgRedirectRepositoryModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationMembershipService };
