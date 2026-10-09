import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerSummaryService,
  moduleLoader as notetakerSummaryServiceModuleLoader,
} from "./NotetakerSummaryService.module";

const notetakerSummaryServiceContainer = createContainer();

export function getNotetakerSummaryService(): NotetakerSummaryService {
  notetakerSummaryServiceModuleLoader.loadModule(notetakerSummaryServiceContainer);

  return notetakerSummaryServiceContainer.get<NotetakerSummaryService>(
    notetakerSummaryServiceModuleLoader.token
  );
}
