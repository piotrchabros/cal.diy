import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { ORGANIZATIONS_DI_TOKENS } from "@calcom/features/organizations/di/tokens";
import { PrismaTempOrgRedirectRepository } from "@calcom/features/organizations/repositories/PrismaTempOrgRedirectRepository";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.TEMP_ORG_REDIRECT_REPOSITORY;
const moduleToken = ORGANIZATIONS_DI_TOKENS.TEMP_ORG_REDIRECT_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaTempOrgRedirectRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { PrismaTempOrgRedirectRepository };
