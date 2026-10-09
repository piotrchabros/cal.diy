import { createContainer } from "@calcom/features/di/di";
import type { NotetakerTasker } from "@calcom/features/notetaker/lib/tasker/NotetakerTasker";
import { moduleLoader as taskerModuleLoader } from "./NotetakerTasker.module";

const container = createContainer();

export function getNotetakerTasker(): NotetakerTasker {
  taskerModuleLoader.loadModule(container);
  return container.get<NotetakerTasker>(taskerModuleLoader.token);
}
