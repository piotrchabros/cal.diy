import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerServiceModule } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerTriggerTasker } from "@calcom/features/notetaker/lib/tasker/NotetakerTriggerTasker";
import { NOTETAKER_TASKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_TRIGGER_TASKER;
const moduleToken = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_TRIGGER_TASKER_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerTriggerTasker,
  depsMap: {
    logger: loggerServiceModule,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
