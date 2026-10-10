import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as featuresRepositoryModuleLoader } from "@calcom/features/di/modules/FeaturesRepository";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { NotetakerSharingSettingsService } from "@calcom/features/notetaker/services/NotetakerSharingSettingsService";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as eventTypeNotetakerSettingsRepositoryModuleLoader } from "./PrismaEventTypeNotetakerSettingsRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_SHARING_SETTINGS_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_SHARING_SETTINGS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerSharingSettingsService,
  depsMap: {
    eventTypeNotetakerSettingsRepository: eventTypeNotetakerSettingsRepositoryModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
    featuresRepository: featuresRepositoryModuleLoader,
    userRepository: userRepositoryModuleLoader,
    config: configModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerSharingSettingsService };
