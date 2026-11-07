import { createContainer } from "@calcom/features/di/di";
import { type TeamRepository, moduleLoader as teamRepositoryModuleLoader } from "./TeamRepository.module";

const teamRepositoryContainer = createContainer();

export function getTeamRepository(): TeamRepository {
  teamRepositoryModuleLoader.loadModule(teamRepositoryContainer);
  return teamRepositoryContainer.get<TeamRepository>(teamRepositoryModuleLoader.token);
}
