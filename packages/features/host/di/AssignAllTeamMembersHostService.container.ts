import { createContainer } from "@calcom/features/di/di";
import {
  type AssignAllTeamMembersHostService,
  moduleLoader as assignAllTeamMembersHostServiceModuleLoader,
} from "./AssignAllTeamMembersHostService.module";

const assignAllTeamMembersHostServiceContainer = createContainer();

export function getAssignAllTeamMembersHostService(): AssignAllTeamMembersHostService {
  assignAllTeamMembersHostServiceModuleLoader.loadModule(assignAllTeamMembersHostServiceContainer);
  return assignAllTeamMembersHostServiceContainer.get<AssignAllTeamMembersHostService>(
    assignAllTeamMembersHostServiceModuleLoader.token
  );
}
