import { createContainer } from "@calcom/features/di/di";
import { moduleLoader as eventTypeRepositoryModuleLoader } from "@calcom/features/di/modules/EventType";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import type { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";

const eventTypeRepositoryContainer = createContainer();

export function getEventTypeRepository(): EventTypeRepository {
  // The EventType module binds the repository to PRISMA_CLIENT without loading the Prisma module itself
  prismaModuleLoader.loadModule(eventTypeRepositoryContainer);
  eventTypeRepositoryModuleLoader.loadModule(eventTypeRepositoryContainer);
  return eventTypeRepositoryContainer.get<EventTypeRepository>(eventTypeRepositoryModuleLoader.token);
}
