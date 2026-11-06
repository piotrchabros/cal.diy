import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationService,
  moduleLoader as organizationServiceModuleLoader,
} from "./OrganizationService.module";

const organizationServiceContainer = createContainer();

export function getOrganizationService(): OrganizationService {
  organizationServiceModuleLoader.loadModule(organizationServiceContainer);

  return organizationServiceContainer.get<OrganizationService>(organizationServiceModuleLoader.token);
}
