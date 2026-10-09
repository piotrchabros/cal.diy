import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerFinalizeService,
  moduleLoader as notetakerFinalizeServiceModuleLoader,
} from "./NotetakerFinalizeService.module";

const notetakerFinalizeServiceContainer = createContainer();

export function getNotetakerFinalizeService(): NotetakerFinalizeService {
  notetakerFinalizeServiceModuleLoader.loadModule(notetakerFinalizeServiceContainer);

  return notetakerFinalizeServiceContainer.get<NotetakerFinalizeService>(
    notetakerFinalizeServiceModuleLoader.token
  );
}
