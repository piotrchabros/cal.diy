import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as tempOrgRedirectRepositoryModuleLoader } from "@calcom/features/organizations/di/PrismaTempOrgRedirectRepository.module";
import { TeamCreationService } from "@calcom/features/teams/services/TeamCreationService";
import { moduleLoader as teamRepositoryModuleLoader } from "./TeamRepository.module";
import { TEAMS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = TEAMS_DI_TOKENS.TEAM_CREATION_SERVICE;
const moduleToken = TEAMS_DI_TOKENS.TEAM_CREATION_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: TeamCreationService,
  depsMap: {
    teamRepo: teamRepositoryModuleLoader,
    tempOrgRedirectRepo: tempOrgRedirectRepositoryModuleLoader,
  },
});

export const moduleLoader: ModuleLoader = {
  token,
  loadModule,
};

export type { TeamCreationService };
