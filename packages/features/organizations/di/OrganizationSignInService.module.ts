import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationSignInService } from "@calcom/features/organizations/services/OrganizationSignInService";
import { moduleLoader as organizationUrlServiceModuleLoader } from "./OrganizationUrlService.module";
import { moduleLoader as organizationMembershipRepositoryModuleLoader } from "./PrismaOrganizationMembershipRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SIGN_IN_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SIGN_IN_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationSignInService,
  depsMap: {
    organizationMembershipRepository: organizationMembershipRepositoryModuleLoader,
    organizationUrlService: organizationUrlServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationSignInService };
