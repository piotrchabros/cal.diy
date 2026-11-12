import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationEmailSenderService,
  moduleLoader as organizationEmailSenderServiceModuleLoader,
} from "./OrganizationEmailSenderService.module";

const organizationEmailSenderServiceContainer = createContainer();

export function getOrganizationEmailSenderService(): OrganizationEmailSenderService {
  organizationEmailSenderServiceModuleLoader.loadModule(organizationEmailSenderServiceContainer);

  return organizationEmailSenderServiceContainer.get<OrganizationEmailSenderService>(
    organizationEmailSenderServiceModuleLoader.token
  );
}
