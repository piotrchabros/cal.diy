import { createContainer } from "@calcom/features/di/di";
import {
  type TeamAccessService,
  moduleLoader as teamAccessServiceModuleLoader,
} from "./TeamAccessService.module";

const teamAccessServiceContainer = createContainer();

export function getTeamAccessService(): TeamAccessService {
  teamAccessServiceModuleLoader.loadModule(teamAccessServiceContainer);
  return teamAccessServiceContainer.get<TeamAccessService>(teamAccessServiceModuleLoader.token);
}
