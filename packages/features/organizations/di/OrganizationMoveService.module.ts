import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationMoveService } from "@calcom/features/organizations/services/OrganizationMoveService";
import { moduleLoader as organizationUrlServiceModuleLoader } from "./OrganizationUrlService.module";
import { moduleLoader as organizationMembershipRepositoryModuleLoader } from "./PrismaOrganizationMembershipRepository.module";
import { moduleLoader as organizationMoveRepositoryModuleLoader } from "./PrismaOrganizationMoveRepository.module";
import { moduleLoader as organizationRepositoryModuleLoader } from "./PrismaOrganizationRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_MOVE_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_MOVE_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationMoveService,
  depsMap: {
    organizationMoveRepository: organizationMoveRepositoryModuleLoader,
    organizationMembershipRepository: organizationMembershipRepositoryModuleLoader,
    organizationRepository: organizationRepositoryModuleLoader,
    organizationUrlService: organizationUrlServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationMoveService };
