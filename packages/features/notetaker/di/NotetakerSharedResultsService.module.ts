import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { NotetakerSharedResultsService } from "@calcom/features/notetaker/services/NotetakerSharedResultsService";
import { moduleLoader as membershipLookupModuleLoader } from "./NotetakerMembershipLookup.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as eventTypeNotetakerSettingsRepositoryModuleLoader } from "./PrismaEventTypeNotetakerSettingsRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_SHARED_RESULTS_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_SHARED_RESULTS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerSharedResultsService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    eventTypeNotetakerSettingsRepository: eventTypeNotetakerSettingsRepositoryModuleLoader,
    membershipLookup: membershipLookupModuleLoader,
    userRepository: userRepositoryModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerSharedResultsService };
