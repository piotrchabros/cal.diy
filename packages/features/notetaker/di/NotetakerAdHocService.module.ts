import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as featuresRepositoryModuleLoader } from "@calcom/features/di/modules/FeaturesRepository";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as loggerServiceModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerAdHocService } from "@calcom/features/notetaker/services/NotetakerAdHocService";
import { moduleLoader as choiceServiceModuleLoader } from "./NotetakerChoiceService.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as dispatchServiceModuleLoader } from "./NotetakerDispatchService.module";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as eventTypeNotetakerSettingsRepositoryModuleLoader } from "./PrismaEventTypeNotetakerSettingsRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_AD_HOC_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_AD_HOC_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerAdHocService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    eventTypeNotetakerSettingsRepository: eventTypeNotetakerSettingsRepositoryModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
    featuresRepository: featuresRepositoryModuleLoader,
    choiceService: choiceServiceModuleLoader,
    dispatchService: dispatchServiceModuleLoader,
    userRepository: userRepositoryModuleLoader,
    config: configModuleLoader,
    logger: loggerServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerAdHocService };
