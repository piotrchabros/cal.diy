import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as userRepositoryModuleLoader } from "@calcom/features/di/modules/User";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerDispatchService } from "@calcom/features/notetaker/services/NotetakerDispatchService";
import { moduleLoader as accessServiceModuleLoader } from "./NotetakerAccessService.module";
import { moduleLoader as botGatewayResolverModuleLoader } from "./NotetakerBotGateway.module";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as bookingNotetakerRepositoryModuleLoader } from "./PrismaBookingNotetakerRepository.module";
import { moduleLoader as activityRepositoryModuleLoader } from "./PrismaNotetakerActivityRepository.module";
import { moduleLoader as sessionRepositoryModuleLoader } from "./PrismaNotetakerSessionRepository.module";
import { moduleLoader as notetakerTaskerModuleLoader } from "./tasker/NotetakerTasker.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_DISPATCH_SERVICE;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_DISPATCH_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerDispatchService,
  depsMap: {
    bookingNotetakerRepository: bookingNotetakerRepositoryModuleLoader,
    sessionRepository: sessionRepositoryModuleLoader,
    activityRepository: activityRepositoryModuleLoader,
    botGatewayResolver: botGatewayResolverModuleLoader,
    config: configModuleLoader,
    logger: loggerModuleLoader,
    accessService: accessServiceModuleLoader,
    userRepository: userRepositoryModuleLoader,
    notetakerTasker: notetakerTaskerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { NotetakerDispatchService };
