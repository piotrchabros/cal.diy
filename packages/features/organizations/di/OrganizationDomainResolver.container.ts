import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationDomainResolver,
  moduleLoader as organizationDomainResolverModuleLoader,
} from "./OrganizationDomainResolver.module";

// Module-level so the resolver, and with it the host cache, is one singleton per process
// (toClass bindings default to singleton scope within a container).
const organizationDomainResolverContainer = createContainer();

export function getOrganizationDomainResolver(): OrganizationDomainResolver {
  organizationDomainResolverModuleLoader.loadModule(organizationDomainResolverContainer);

  return organizationDomainResolverContainer.get<OrganizationDomainResolver>(
    organizationDomainResolverModuleLoader.token
  );
}
