import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerSharingSettingsService,
  moduleLoader as notetakerSharingSettingsServiceModuleLoader,
} from "./NotetakerSharingSettingsService.module";

const notetakerSharingSettingsServiceContainer = createContainer();

export function getNotetakerSharingSettingsService(): NotetakerSharingSettingsService {
  notetakerSharingSettingsServiceModuleLoader.loadModule(notetakerSharingSettingsServiceContainer);

  return notetakerSharingSettingsServiceContainer.get<NotetakerSharingSettingsService>(
    notetakerSharingSettingsServiceModuleLoader.token
  );
}
