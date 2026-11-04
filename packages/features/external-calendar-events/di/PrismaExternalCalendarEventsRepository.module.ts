import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { PrismaExternalCalendarEventsRepository } from "@calcom/features/external-calendar-events/repositories/PrismaExternalCalendarEventsRepository";
import { EXTERNAL_CALENDAR_EVENTS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = EXTERNAL_CALENDAR_EVENTS_DI_TOKENS.EXTERNAL_CALENDAR_EVENTS_REPOSITORY;
const moduleToken = EXTERNAL_CALENDAR_EVENTS_DI_TOKENS.EXTERNAL_CALENDAR_EVENTS_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaExternalCalendarEventsRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
