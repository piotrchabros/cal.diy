import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerChoiceService,
  moduleLoader as notetakerChoiceServiceModuleLoader,
} from "./NotetakerChoiceService.module";

const notetakerChoiceServiceContainer = createContainer();

export function getNotetakerChoiceService(): NotetakerChoiceService {
  notetakerChoiceServiceModuleLoader.loadModule(notetakerChoiceServiceContainer);

  return notetakerChoiceServiceContainer.get<NotetakerChoiceService>(
    notetakerChoiceServiceModuleLoader.token
  );
}
