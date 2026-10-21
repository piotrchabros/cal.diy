import { createContainer } from "@calcom/features/di/di";
import {
  type RecallWebhookService,
  moduleLoader as recallWebhookServiceModuleLoader,
} from "./RecallWebhookService.module";

// Module-level so the bound singleton survives across requests: the per-bot serialisation queue
// lives on the service instance and would not serialise anything if each request got a new one.
const recallWebhookServiceContainer = createContainer();

export function getRecallWebhookService(): RecallWebhookService {
  recallWebhookServiceModuleLoader.loadModule(recallWebhookServiceContainer);

  return recallWebhookServiceContainer.get<RecallWebhookService>(recallWebhookServiceModuleLoader.token);
}
