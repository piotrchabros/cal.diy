import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type IExternalCalendarEventsCache,
  InMemoryExternalCalendarEventsCache,
} from "@calcom/features/external-calendar-events/lib/InMemoryExternalCalendarEventsCache";
import { EXTERNAL_CALENDAR_EVENTS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = EXTERNAL_CALENDAR_EVENTS_DI_TOKENS.EXTERNAL_CALENDAR_EVENTS_CACHE;
const moduleToken = EXTERNAL_CALENDAR_EVENTS_DI_TOKENS.EXTERNAL_CALENDAR_EVENTS_CACHE_MODULE;
const MAX_CACHE_ENTRIES = 500;

// Singleton so every request in the process shares one cache; a per-resolve instance would never hit.
thisModule
  .bind(token)
  .toFactory(
    (): IExternalCalendarEventsCache =>
      new InMemoryExternalCalendarEventsCache({ maxEntries: MAX_CACHE_ENTRIES }),
    "singleton"
  );

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
