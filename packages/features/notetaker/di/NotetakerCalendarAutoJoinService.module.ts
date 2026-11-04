import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as featuresRepositoryModuleLoader } from "@calcom/features/di/modules/FeaturesRepository";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerCalendarAutoJoinService } from "@calcom/features/notetaker/services/NotetakerCalendarAutoJoinService";
import { moduleLoader as eventsGatewayResolverModuleLoader } from "./NotetakerCalendarEventsGatewayResolver.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as autoJoinRepositoryModuleLoader } from "./PrismaNotetakerCalendarAutoJoinRepository.module";
import { moduleLoader as calendarMeetingRepositoryModuleLoader } from "./PrismaNotetakerCalendarMeetingRepository.module";
import { moduleLoader as meetingContactRepositoryModuleLoader } from "./PrismaNotetakerMeetingContactRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_AUTO_JOIN_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_AUTO_JOIN_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerCalendarAutoJoinService,
  depsMap: {
    autoJoinRepository: autoJoinRepositoryModuleLoader,
    calendarMeetingRepository: calendarMeetingRepositoryModuleLoader,
    meetingContactRepository: meetingContactRepositoryModuleLoader,
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    eventsGatewayResolver: eventsGatewayResolverModuleLoader,
    featuresRepository: featuresRepositoryModuleLoader,
    userRepository: userRepositoryModuleLoader,
    config: configModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerCalendarAutoJoinService };
