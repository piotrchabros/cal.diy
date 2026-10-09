import { createContainer } from "@calcom/features/di/di";
import type { NotetakerTaskService } from "@calcom/features/notetaker/lib/tasker/NotetakerTaskService";
import { moduleLoader as taskServiceModuleLoader } from "./NotetakerTaskService.module";

const container = createContainer();

export function getNotetakerTaskService(): NotetakerTaskService {
  taskServiceModuleLoader.loadModule(container);
  return container.get<NotetakerTaskService>(taskServiceModuleLoader.token);
}
