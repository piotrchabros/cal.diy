import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerResultsService,
  moduleLoader as notetakerResultsServiceModuleLoader,
} from "./NotetakerResultsService.module";

const notetakerResultsServiceContainer = createContainer();

export function getNotetakerResultsService(): NotetakerResultsService {
  notetakerResultsServiceModuleLoader.loadModule(notetakerResultsServiceContainer);

  return notetakerResultsServiceContainer.get<NotetakerResultsService>(
    notetakerResultsServiceModuleLoader.token
  );
}
