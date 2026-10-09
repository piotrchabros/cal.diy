import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerServiceModule } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerSyncTasker } from "@calcom/features/notetaker/lib/tasker/NotetakerSyncTasker";
import { moduleLoader as notetakerTaskServiceModuleLoader } from "./NotetakerTaskService.module";
import { NOTETAKER_TASKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_SYNC_TASKER;
const moduleToken = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_SYNC_TASKER_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerSyncTasker,
  depsMap: {
    logger: loggerServiceModule,
    notetakerTaskService: notetakerTaskServiceModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
