import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationMembershipService,
  moduleLoader as organizationMembershipServiceModuleLoader,
} from "./OrganizationMembershipService.module";

const organizationMembershipServiceContainer = createContainer();

export function getOrganizationMembershipService(): OrganizationMembershipService {
  organizationMembershipServiceModuleLoader.loadModule(organizationMembershipServiceContainer);

  return organizationMembershipServiceContainer.get<OrganizationMembershipService>(
    organizationMembershipServiceModuleLoader.token
  );
}
