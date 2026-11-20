import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { RecallRealtimeEventService } from "@calcom/features/notetaker/services/RecallRealtimeEventService";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as meetingAgentModuleLoader } from "./NotetakerMeetingAgent.module";
import { moduleLoader as speechSynthesizerModuleLoader } from "./NotetakerMeetingAgentSpeechSynthesizer.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as recallApiClientModuleLoader } from "./RecallApiClient.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.RECALL_REALTIME_EVENT_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.RECALL_REALTIME_EVENT_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: RecallRealtimeEventService,
  depsMap: {
    recallClient: recallApiClientModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    meetingAgent: meetingAgentModuleLoader,
    speechSynthesizer: speechSynthesizerModuleLoader,
    config: configModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { RecallRealtimeEventService };
