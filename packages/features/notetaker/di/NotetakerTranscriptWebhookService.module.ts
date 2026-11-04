import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerServiceModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerTranscriptWebhookService } from "@calcom/features/notetaker/services/NotetakerTranscriptWebhookService";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as notetakerTranscriptWebhookGatewayModuleLoader } from "./NotetakerTranscriptWebhookGateway.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as notetakerSessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as notetakerSummaryRepositoryModuleLoader } from "./PrismaNotetakerSummaryRepository.module";
import { moduleLoader as notetakerTranscriptRepositoryModuleLoader } from "./PrismaNotetakerTranscriptRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_TRANSCRIPT_WEBHOOK_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_TRANSCRIPT_WEBHOOK_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerTranscriptWebhookService,
  depsMap: {
    sessionRepository: notetakerSessionRepositoryModuleLoader,
    transcriptRepository: notetakerTranscriptRepositoryModuleLoader,
    summaryRepository: notetakerSummaryRepositoryModuleLoader,
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    webhookGateway: notetakerTranscriptWebhookGatewayModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
    logger: loggerServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerTranscriptWebhookService };
