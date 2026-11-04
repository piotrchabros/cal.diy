import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as featuresRepositoryModuleLoader } from "@calcom/features/di/modules/FeaturesRepository";
import { NotetakerCalendarAutoJoinSettingsService } from "@calcom/features/notetaker/services/NotetakerCalendarAutoJoinSettingsService";
import { moduleLoader as calendarEventsGatewayResolverModuleLoader } from "./NotetakerCalendarEventsGatewayResolver.module";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as eventTypeNotetakerSettingsRepositoryModuleLoader } from "./PrismaEventTypeNotetakerSettingsRepository.module";
import { moduleLoader as autoJoinRepositoryModuleLoader } from "./PrismaNotetakerCalendarAutoJoinRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_AUTO_JOIN_SETTINGS_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_AUTO_JOIN_SETTINGS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerCalendarAutoJoinSettingsService,
  depsMap: {
    autoJoinRepository: autoJoinRepositoryModuleLoader,
    calendarEventsGatewayResolver: calendarEventsGatewayResolverModuleLoader,
    eventTypeNotetakerSettingsRepository: eventTypeNotetakerSettingsRepositoryModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
    featuresRepository: featuresRepositoryModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerCalendarAutoJoinSettingsService };
