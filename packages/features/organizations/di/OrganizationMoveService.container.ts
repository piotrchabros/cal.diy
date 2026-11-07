import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationMoveService,
  moduleLoader as organizationMoveServiceModuleLoader,
} from "./OrganizationMoveService.module";

const organizationMoveServiceContainer = createContainer();

export function getOrganizationMoveService(): OrganizationMoveService {
  organizationMoveServiceModuleLoader.loadModule(organizationMoveServiceContainer);

  return organizationMoveServiceContainer.get<OrganizationMoveService>(
    organizationMoveServiceModuleLoader.token
  );
}
