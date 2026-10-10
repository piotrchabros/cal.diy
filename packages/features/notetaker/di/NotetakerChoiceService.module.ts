import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as featuresRepositoryModuleLoader } from "@calcom/features/di/modules/FeaturesRepository";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as loggerServiceModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerChoiceService } from "@calcom/features/notetaker/services/NotetakerChoiceService";
import { moduleLoader as accessServiceModuleLoader } from "./NotetakerAccessService.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as eventTypeNotetakerSettingsRepositoryModuleLoader } from "./PrismaEventTypeNotetakerSettingsRepository.module";
import { moduleLoader as activityRepositoryModuleLoader } from "./PrismaNotetakerActivityRepository.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as summaryRepositoryModuleLoader } from "./PrismaNotetakerSummaryRepository.module";
import { moduleLoader as transcriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { moduleLoader as notetakerTaskerModuleLoader } from "./tasker/NotetakerTasker.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CHOICE_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CHOICE_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerChoiceService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    eventTypeNotetakerSettingsRepository: eventTypeNotetakerSettingsRepositoryModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    transcriptRepository: transcriptRepositoryModuleLoader,
    summaryRepository: summaryRepositoryModuleLoader,
    activityRepository: activityRepositoryModuleLoader,
    accessService: accessServiceModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
    featuresRepository: featuresRepositoryModuleLoader,
    userRepository: userRepositoryModuleLoader,
    config: configModuleLoader,
    notetakerTasker: notetakerTaskerModuleLoader,
    logger: loggerServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerChoiceService };
