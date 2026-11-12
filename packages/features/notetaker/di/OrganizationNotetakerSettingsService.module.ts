import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationNotetakerSettingsService } from "@calcom/features/notetaker/services/OrganizationNotetakerSettingsService";
import { moduleLoader as organizationMembershipServiceModuleLoader } from "@calcom/features/organizations/di/OrganizationMembershipService.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as settingsRepositoryModuleLoader } from "./PrismaOrganizationNotetakerSettingsRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.ORGANIZATION_NOTETAKER_SETTINGS_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.ORGANIZATION_NOTETAKER_SETTINGS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationNotetakerSettingsService,
  depsMap: {
    settingsRepository: settingsRepositoryModuleLoader,
    organizationMembershipService: organizationMembershipServiceModuleLoader,
    config: configModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationNotetakerSettingsService };
