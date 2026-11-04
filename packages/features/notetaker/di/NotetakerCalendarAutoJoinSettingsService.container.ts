import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerCalendarAutoJoinSettingsService,
  moduleLoader as notetakerCalendarAutoJoinSettingsServiceModuleLoader,
} from "./NotetakerCalendarAutoJoinSettingsService.module";

const notetakerCalendarAutoJoinSettingsServiceContainer = createContainer();

export function getNotetakerCalendarAutoJoinSettingsService(): NotetakerCalendarAutoJoinSettingsService {
  notetakerCalendarAutoJoinSettingsServiceModuleLoader.loadModule(
    notetakerCalendarAutoJoinSettingsServiceContainer
  );

  return notetakerCalendarAutoJoinSettingsServiceContainer.get<NotetakerCalendarAutoJoinSettingsService>(
    notetakerCalendarAutoJoinSettingsServiceModuleLoader.token
  );
}
