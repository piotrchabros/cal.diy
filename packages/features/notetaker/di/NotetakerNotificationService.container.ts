import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerNotificationService,
  moduleLoader as notetakerNotificationServiceModuleLoader,
} from "./NotetakerNotificationService.module";

const notetakerNotificationServiceContainer = createContainer();

export function getNotetakerNotificationService(): NotetakerNotificationService {
  notetakerNotificationServiceModuleLoader.loadModule(notetakerNotificationServiceContainer);

  return notetakerNotificationServiceContainer.get<NotetakerNotificationService>(
    notetakerNotificationServiceModuleLoader.token
  );
}
