import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationUrlService,
  moduleLoader as organizationUrlServiceModuleLoader,
} from "./OrganizationUrlService.module";

// Module-level so the service, and with it the base-URL cache, is one singleton per process.
const organizationUrlServiceContainer = createContainer();

export function getOrganizationUrlService(): OrganizationUrlService {
  organizationUrlServiceModuleLoader.loadModule(organizationUrlServiceContainer);

  return organizationUrlServiceContainer.get<OrganizationUrlService>(
    organizationUrlServiceModuleLoader.token
  );
}
