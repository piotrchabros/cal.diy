import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerServiceModule } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerTasker } from "@calcom/features/notetaker/lib/tasker/NotetakerTasker";
import { moduleLoader as notetakerSyncTaskerModuleLoader } from "./NotetakerSyncTasker.module";
import { moduleLoader as notetakerTriggerTaskerModuleLoader } from "./NotetakerTriggerTasker.module";
import { NOTETAKER_TASKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_TASKER;
const moduleToken = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_TASKER_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerTasker,
  depsMap: {
    logger: loggerServiceModule,
    syncTasker: notetakerSyncTaskerModuleLoader,
    asyncTasker: notetakerTriggerTaskerModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
