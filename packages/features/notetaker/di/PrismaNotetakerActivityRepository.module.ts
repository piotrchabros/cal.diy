import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { NOTETAKER_DI_TOKENS } from "@calcom/features/notetaker/di/tokens";
import { PrismaNotetakerActivityRepository } from "@calcom/features/notetaker/repositories/PrismaNotetakerActivityRepository";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_ACTIVITY_REPOSITORY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_ACTIVITY_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaNotetakerActivityRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { PrismaNotetakerActivityRepository };
