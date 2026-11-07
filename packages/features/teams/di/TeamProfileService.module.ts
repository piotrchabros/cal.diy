import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { TeamProfileService } from "@calcom/features/teams/services/TeamProfileService";
import { moduleLoader as membershipRepositoryModuleLoader } from "@calcom/features/users/di/MembershipRepository.module";
import { moduleLoader as teamRepositoryModuleLoader } from "./TeamRepository.module";
import { TEAMS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = TEAMS_DI_TOKENS.TEAM_PROFILE_SERVICE;
const moduleToken = TEAMS_DI_TOKENS.TEAM_PROFILE_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: TeamProfileService,
  depsMap: {
    teamRepo: teamRepositoryModuleLoader,
    membershipRepo: membershipRepositoryModuleLoader,
  },
});

export const moduleLoader: ModuleLoader = {
  token,
  loadModule,
};

export type { TeamProfileService };
