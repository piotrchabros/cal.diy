import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerAdHocService,
  moduleLoader as notetakerAdHocServiceModuleLoader,
} from "./NotetakerAdHocService.module";

const notetakerAdHocServiceContainer = createContainer();

export function getNotetakerAdHocService(): NotetakerAdHocService {
  notetakerAdHocServiceModuleLoader.loadModule(notetakerAdHocServiceContainer);

  return notetakerAdHocServiceContainer.get<NotetakerAdHocService>(notetakerAdHocServiceModuleLoader.token);
}
