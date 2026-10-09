import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerSessionEventService } from "@calcom/features/notetaker/services/NotetakerSessionEventService";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as activityRepositoryModuleLoader } from "./PrismaNotetakerActivityRepository.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as transcriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { moduleLoader as notetakerTaskerModuleLoader } from "./tasker/NotetakerTasker.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_SESSION_EVENT_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_SESSION_EVENT_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerSessionEventService,
  depsMap: {
    sessionRepository: sessionRepositoryModuleLoader,
    transcriptRepository: transcriptRepositoryModuleLoader,
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    activityRepository: activityRepositoryModuleLoader,
    notetakerTasker: notetakerTaskerModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerSessionEventService };
