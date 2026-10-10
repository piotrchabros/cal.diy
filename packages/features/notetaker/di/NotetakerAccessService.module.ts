import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { NotetakerAccessService } from "@calcom/features/notetaker/services/NotetakerAccessService";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as eventTypeNotetakerSettingsRepositoryModuleLoader } from "./PrismaEventTypeNotetakerSettingsRepository.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_ACCESS_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_ACCESS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerAccessService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    eventTypeNotetakerSettingsRepository: eventTypeNotetakerSettingsRepositoryModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerAccessService };
