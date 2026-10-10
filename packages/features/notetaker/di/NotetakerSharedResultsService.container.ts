import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerSharedResultsService,
  moduleLoader as notetakerSharedResultsServiceModuleLoader,
} from "./NotetakerSharedResultsService.module";

const notetakerSharedResultsServiceContainer = createContainer();

export function getNotetakerSharedResultsService(): NotetakerSharedResultsService {
  notetakerSharedResultsServiceModuleLoader.loadModule(notetakerSharedResultsServiceContainer);

  return notetakerSharedResultsServiceContainer.get<NotetakerSharedResultsService>(
    notetakerSharedResultsServiceModuleLoader.token
  );
}
