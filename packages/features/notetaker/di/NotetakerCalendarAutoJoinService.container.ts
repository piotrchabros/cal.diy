import { createContainer } from "@calcom/features/di/di";
import {
  type NotetakerCalendarAutoJoinService,
  moduleLoader as notetakerCalendarAutoJoinServiceModuleLoader,
} from "./NotetakerCalendarAutoJoinService.module";

const notetakerCalendarAutoJoinServiceContainer = createContainer();

export function getNotetakerCalendarAutoJoinService(): NotetakerCalendarAutoJoinService {
  notetakerCalendarAutoJoinServiceModuleLoader.loadModule(notetakerCalendarAutoJoinServiceContainer);

  return notetakerCalendarAutoJoinServiceContainer.get<NotetakerCalendarAutoJoinService>(
    notetakerCalendarAutoJoinServiceModuleLoader.token
  );
}
