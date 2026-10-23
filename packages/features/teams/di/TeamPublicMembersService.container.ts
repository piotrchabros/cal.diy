import { createContainer } from "@calcom/features/di/di";
import {
  type TeamPublicMembersService,
  moduleLoader as teamPublicMembersServiceModuleLoader,
} from "./TeamPublicMembersService.module";

const teamPublicMembersServiceContainer = createContainer();

export function getTeamPublicMembersService(): TeamPublicMembersService {
  teamPublicMembersServiceModuleLoader.loadModule(teamPublicMembersServiceContainer);
  return teamPublicMembersServiceContainer.get<TeamPublicMembersService>(
    teamPublicMembersServiceModuleLoader.token
  );
}
