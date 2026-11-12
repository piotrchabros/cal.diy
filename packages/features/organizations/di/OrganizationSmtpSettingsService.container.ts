import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationSmtpSettingsService,
  moduleLoader as organizationSmtpSettingsServiceModuleLoader,
} from "./OrganizationSmtpSettingsService.module";

const organizationSmtpSettingsServiceContainer = createContainer();

export function getOrganizationSmtpSettingsService(): OrganizationSmtpSettingsService {
  organizationSmtpSettingsServiceModuleLoader.loadModule(organizationSmtpSettingsServiceContainer);

  return organizationSmtpSettingsServiceContainer.get<OrganizationSmtpSettingsService>(
    organizationSmtpSettingsServiceModuleLoader.token
  );
}
