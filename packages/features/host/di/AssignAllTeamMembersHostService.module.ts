import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as eventTypeRepositoryModuleLoader } from "@calcom/features/di/modules/EventType";
import { moduleLoader as hostRepositoryModuleLoader } from "@calcom/features/di/modules/Host";
import { AssignAllTeamMembersHostService } from "@calcom/features/host/services/AssignAllTeamMembersHostService";
import { moduleLoader as membershipRepositoryModuleLoader } from "@calcom/features/users/di/MembershipRepository.module";
import { HOST_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = HOST_DI_TOKENS.ASSIGN_ALL_TEAM_MEMBERS_HOST_SERVICE;
const moduleToken = HOST_DI_TOKENS.ASSIGN_ALL_TEAM_MEMBERS_HOST_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: AssignAllTeamMembersHostService,
  depsMap: {
    hostRepository: hostRepositoryModuleLoader,
    eventTypeRepository: eventTypeRepositoryModuleLoader,
    membershipRepository: membershipRepositoryModuleLoader,
  },
});

export const moduleLoader: ModuleLoader = {
  token,
  loadModule,
};

export type { AssignAllTeamMembersHostService };
