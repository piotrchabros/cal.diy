import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationService } from "@calcom/features/organizations/services/OrganizationService";
import { moduleLoader as organizationsConfigModuleLoader } from "./OrganizationsConfig.module";
import { moduleLoader as organizationRepositoryModuleLoader } from "./PrismaOrganizationRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationService,
  depsMap: {
    organizationRepository: organizationRepositoryModuleLoader,
    organizationsConfig: organizationsConfigModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationService };
