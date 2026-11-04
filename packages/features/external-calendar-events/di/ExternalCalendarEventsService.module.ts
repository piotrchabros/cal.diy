import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as featuresRepositoryModuleLoader } from "@calcom/features/di/modules/FeaturesRepository";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { ExternalCalendarEventsService } from "@calcom/features/external-calendar-events/services/ExternalCalendarEventsService";
import { moduleLoader as eventsGatewayResolverModuleLoader } from "@calcom/features/notetaker/di/NotetakerCalendarEventsGatewayResolver.module";
import { moduleLoader as cacheModuleLoader } from "./ExternalCalendarEventsCache.module";
import { moduleLoader as repositoryModuleLoader } from "./PrismaExternalCalendarEventsRepository.module";
import { EXTERNAL_CALENDAR_EVENTS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = EXTERNAL_CALENDAR_EVENTS_DI_TOKENS.EXTERNAL_CALENDAR_EVENTS_SERVICE;
const moduleToken = EXTERNAL_CALENDAR_EVENTS_DI_TOKENS.EXTERNAL_CALENDAR_EVENTS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: ExternalCalendarEventsService,
  depsMap: {
    repository: repositoryModuleLoader,
    eventsGatewayResolver: eventsGatewayResolverModuleLoader,
    featuresRepository: featuresRepositoryModuleLoader,
    cache: cacheModuleLoader,
    logger: loggerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { ExternalCalendarEventsService };
