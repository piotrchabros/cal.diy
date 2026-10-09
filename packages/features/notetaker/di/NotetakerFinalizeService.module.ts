import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerServiceModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerFinalizeService } from "@calcom/features/notetaker/services/NotetakerFinalizeService";
import { moduleLoader as notetakerSessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as notetakerTranscriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { moduleLoader as notetakerTaskerModuleLoader } from "./tasker/NotetakerTasker.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_FINALIZE_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_FINALIZE_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerFinalizeService,
  depsMap: {
    sessionRepository: notetakerSessionRepositoryModuleLoader,
    transcriptRepository: notetakerTranscriptRepositoryModuleLoader,
    notetakerTasker: notetakerTaskerModuleLoader,
    logger: loggerServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerFinalizeService };
