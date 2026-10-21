import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { RecallWebhookService } from "@calcom/features/notetaker/services/RecallWebhookService";
import { moduleLoader as sessionEventServiceModuleLoader } from "./NotetakerSessionEventService.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as recallApiClientModuleLoader } from "./RecallApiClient.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.RECALL_WEBHOOK_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.RECALL_WEBHOOK_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: RecallWebhookService,
  depsMap: {
    recallClient: recallApiClientModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    sessionEventService: sessionEventServiceModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { RecallWebhookService };
