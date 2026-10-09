import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerNotificationService } from "@calcom/features/notetaker/services/NotetakerNotificationService";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as activityRepositoryModuleLoader } from "./PrismaNotetakerActivityRepository.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as summaryRepositoryModuleLoader } from "./PrismaNotetakerSummaryRepository.module";
import { moduleLoader as transcriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_NOTIFICATION_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_NOTIFICATION_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerNotificationService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    activityRepository: activityRepositoryModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    transcriptRepository: transcriptRepositoryModuleLoader,
    summaryRepository: summaryRepositoryModuleLoader,
    userRepository: userRepositoryModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerNotificationService };
