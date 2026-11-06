import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationSignInService,
  moduleLoader as organizationSignInServiceModuleLoader,
} from "./OrganizationSignInService.module";

// Module-level so the service, and the base-URL cache of its URL service, exist once per process.
const organizationSignInServiceContainer = createContainer();

export function getOrganizationSignInService(): OrganizationSignInService {
  organizationSignInServiceModuleLoader.loadModule(organizationSignInServiceContainer);

  return organizationSignInServiceContainer.get<OrganizationSignInService>(
    organizationSignInServiceModuleLoader.token
  );
}
