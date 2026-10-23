import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as eventTypeRepositoryModuleLoader } from "@calcom/features/di/modules/EventType";
import { TeamPublicMembersService } from "@calcom/features/teams/services/TeamPublicMembersService";
import { moduleLoader as membershipRepositoryModuleLoader } from "@calcom/features/users/di/MembershipRepository.module";
import { TEAMS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = TEAMS_DI_TOKENS.TEAM_PUBLIC_MEMBERS_SERVICE;
const moduleToken = TEAMS_DI_TOKENS.TEAM_PUBLIC_MEMBERS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: TeamPublicMembersService,
  depsMap: {
    membershipRepo: membershipRepositoryModuleLoader,
    eventTypeRepo: eventTypeRepositoryModuleLoader,
  },
});

export const moduleLoader: ModuleLoader = {
  token,
  loadModule,
};

export type { TeamPublicMembersService };
