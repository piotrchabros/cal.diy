import { createContainer } from "@calcom/features/di/di";
import {
  type TeamProfileService,
  moduleLoader as teamProfileServiceModuleLoader,
} from "./TeamProfileService.module";

const teamProfileServiceContainer = createContainer();

export function getTeamProfileService(): TeamProfileService {
  teamProfileServiceModuleLoader.loadModule(teamProfileServiceContainer);
  return teamProfileServiceContainer.get<TeamProfileService>(teamProfileServiceModuleLoader.token);
}
