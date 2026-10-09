import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerAccessService,
  moduleLoader as notetakerAccessServiceModuleLoader,
} from "./NotetakerAccessService.module";

const notetakerAccessServiceContainer = createContainer();

export function getNotetakerAccessService(): NotetakerAccessService {
  notetakerAccessServiceModuleLoader.loadModule(notetakerAccessServiceContainer);

  return notetakerAccessServiceContainer.get<NotetakerAccessService>(
    notetakerAccessServiceModuleLoader.token
  );
}
