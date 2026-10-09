import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerDispatchService,
  moduleLoader as notetakerDispatchServiceModuleLoader,
} from "./NotetakerDispatchService.module";

const notetakerDispatchServiceContainer = createContainer();

export function getNotetakerDispatchService(): NotetakerDispatchService {
  notetakerDispatchServiceModuleLoader.loadModule(notetakerDispatchServiceContainer);

  return notetakerDispatchServiceContainer.get<NotetakerDispatchService>(
    notetakerDispatchServiceModuleLoader.token
  );
}
