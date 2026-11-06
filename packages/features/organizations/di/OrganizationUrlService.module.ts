import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationUrlService } from "@calcom/features/organizations/services/OrganizationUrlService";
import { moduleLoader as organizationsConfigModuleLoader } from "./OrganizationsConfig.module";
import { moduleLoader as organizationMembershipRepositoryModuleLoader } from "./PrismaOrganizationMembershipRepository.module";
import { moduleLoader as organizationRepositoryModuleLoader } from "./PrismaOrganizationRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_URL_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_URL_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationUrlService,
  depsMap: {
    organizationRepository: organizationRepositoryModuleLoader,
    organizationMembershipRepository: organizationMembershipRepositoryModuleLoader,
    organizationsConfig: organizationsConfigModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationUrlService };
