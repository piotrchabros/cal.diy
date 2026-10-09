import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerCalendarInviteService } from "@calcom/features/notetaker/services/NotetakerCalendarInviteService";
import { moduleLoader as calendarGuestGatewayModuleLoader } from "./NotetakerCalendarGuestGateway.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_INVITE_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_INVITE_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerCalendarInviteService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    calendarGuestGateway: calendarGuestGatewayModuleLoader,
    config: configModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerCalendarInviteService };
