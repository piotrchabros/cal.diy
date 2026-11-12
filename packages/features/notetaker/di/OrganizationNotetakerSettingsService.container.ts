import { createContainer } from "@calcom/features/di/di";
import {
  type OrganizationNotetakerSettingsService,
  moduleLoader as organizationNotetakerSettingsServiceModuleLoader,
} from "./OrganizationNotetakerSettingsService.module";

const organizationNotetakerSettingsServiceContainer = createContainer();

export function getOrganizationNotetakerSettingsService(): OrganizationNotetakerSettingsService {
  organizationNotetakerSettingsServiceModuleLoader.loadModule(organizationNotetakerSettingsServiceContainer);

  return organizationNotetakerSettingsServiceContainer.get<OrganizationNotetakerSettingsService>(
    organizationNotetakerSettingsServiceModuleLoader.token
  );
}
