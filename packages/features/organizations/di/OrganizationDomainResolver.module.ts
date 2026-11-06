import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationDomainResolver } from "@calcom/features/organizations/lib/OrganizationDomainResolver";
import { moduleLoader as organizationsConfigModuleLoader } from "./OrganizationsConfig.module";
import { moduleLoader as organizationRepositoryModuleLoader } from "./PrismaOrganizationRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_DOMAIN_RESOLVER;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_DOMAIN_RESOLVER_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationDomainResolver,
  depsMap: {
    organizationRepository: organizationRepositoryModuleLoader,
    organizationsConfig: organizationsConfigModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationDomainResolver };
