import { createContainer } from "@calcom/features/di/di";
import {
  type TeamCreationService,
  moduleLoader as teamCreationServiceModuleLoader,
} from "./TeamCreationService.module";

const teamCreationServiceContainer = createContainer();

export function getTeamCreationService(): TeamCreationService {
  teamCreationServiceModuleLoader.loadModule(teamCreationServiceContainer);
  return teamCreationServiceContainer.get<TeamCreationService>(teamCreationServiceModuleLoader.token);
}
