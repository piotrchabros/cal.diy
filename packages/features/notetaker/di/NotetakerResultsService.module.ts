import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { NotetakerResultsService } from "@calcom/features/notetaker/services/NotetakerResultsService";
import { moduleLoader as accessServiceModuleLoader } from "./NotetakerAccessService.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as transcriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_RESULTS_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_RESULTS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerResultsService,
  depsMap: {
    accessService: accessServiceModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    transcriptRepository: transcriptRepositoryModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerResultsService };
