import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerSessionEventService,
  moduleLoader as notetakerSessionEventServiceModuleLoader,
} from "./NotetakerSessionEventService.module";

const notetakerSessionEventServiceContainer = createContainer();

export function getNotetakerSessionEventService(): NotetakerSessionEventService {
  notetakerSessionEventServiceModuleLoader.loadModule(notetakerSessionEventServiceContainer);

  return notetakerSessionEventServiceContainer.get<NotetakerSessionEventService>(
    notetakerSessionEventServiceModuleLoader.token
  );
}
