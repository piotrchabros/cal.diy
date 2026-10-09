import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as loggerServiceModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerSummaryService } from "@calcom/features/notetaker/services/NotetakerSummaryService";
import { moduleLoader as accessServiceModuleLoader } from "./NotetakerAccessService.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as summaryGeneratorModuleLoader } from "./NotetakerSummaryGenerator.module";
import { moduleLoader as activityRepositoryModuleLoader } from "./PrismaNotetakerActivityRepository.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as summaryRepositoryModuleLoader } from "./PrismaNotetakerSummaryRepository.module";
import { moduleLoader as transcriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { moduleLoader as notetakerTaskerModuleLoader } from "./tasker/NotetakerTasker.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerSummaryService,
  depsMap: {
    accessService: accessServiceModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    transcriptRepository: transcriptRepositoryModuleLoader,
    summaryRepository: summaryRepositoryModuleLoader,
    activityRepository: activityRepositoryModuleLoader,
    userRepository: userRepositoryModuleLoader,
    summaryGenerator: summaryGeneratorModuleLoader,
    notetakerTasker: notetakerTaskerModuleLoader,
    config: configModuleLoader,
    logger: loggerServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerSummaryService };
