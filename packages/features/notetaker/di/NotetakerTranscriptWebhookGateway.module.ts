import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as bookingRepositoryModuleLoader } from "@calcom/features/di/modules/Booking";
import { moduleLoader as loggerServiceModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { CalcomNotetakerTranscriptWebhookGateway } from "@calcom/features/notetaker/webhooks/CalcomNotetakerTranscriptWebhookGateway";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_TRANSCRIPT_WEBHOOK_GATEWAY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_TRANSCRIPT_WEBHOOK_GATEWAY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: CalcomNotetakerTranscriptWebhookGateway,
  depsMap: {
    bookingRepository: bookingRepositoryModuleLoader,
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    logger: loggerServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { CalcomNotetakerTranscriptWebhookGateway };
