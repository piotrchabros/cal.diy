import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerServiceModule } from "@calcom/features/di/shared/services/logger.service";
import { NotetakerTaskService } from "@calcom/features/notetaker/lib/tasker/NotetakerTaskService";
import { NOTETAKER_TASKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_TASK_SERVICE;
const moduleToken = NOTETAKER_TASKER_DI_TOKENS.NOTETAKER_TASK_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: NotetakerTaskService,
  depsMap: {
    logger: loggerServiceModule,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
