import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { PrismaNotetakerCalendarMeetingRepository } from "@calcom/features/notetaker/repositories/PrismaNotetakerCalendarMeetingRepository";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_MEETING_REPOSITORY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_MEETING_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaNotetakerCalendarMeetingRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
