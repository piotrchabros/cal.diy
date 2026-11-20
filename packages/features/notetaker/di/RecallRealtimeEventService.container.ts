import { createContainer } from "@calcom/features/di/di";
import {
  type RecallRealtimeEventService,
  moduleLoader as recallRealtimeEventServiceModuleLoader,
} from "./RecallRealtimeEventService.module";

// Module-level so the bound singleton survives across requests: the in-memory agent state and the
// per-bot serialisation queues live on the service instance and would be lost if each request got a new one.
const recallRealtimeEventServiceContainer = createContainer();

export function getRecallRealtimeEventService(): RecallRealtimeEventService {
  recallRealtimeEventServiceModuleLoader.loadModule(recallRealtimeEventServiceContainer);

  return recallRealtimeEventServiceContainer.get<RecallRealtimeEventService>(
    recallRealtimeEventServiceModuleLoader.token
  );
}
