import { createContainer } from "@calcom/features/di/di";
import {
  type ExternalCalendarEventsService,
  moduleLoader as externalCalendarEventsServiceModuleLoader,
} from "./ExternalCalendarEventsService.module";

const externalCalendarEventsServiceContainer = createContainer();

export function getExternalCalendarEventsService(): ExternalCalendarEventsService {
  externalCalendarEventsServiceModuleLoader.loadModule(externalCalendarEventsServiceContainer);

  return externalCalendarEventsServiceContainer.get<ExternalCalendarEventsService>(
    externalCalendarEventsServiceModuleLoader.token
  );
}
