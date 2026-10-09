import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { NOTETAKER_DI_TOKENS } from "@calcom/features/notetaker/di/tokens";
import { PrismaNotetakerSummaryRepository } from "@calcom/features/notetaker/repositories/PrismaNotetakerSummaryRepository";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_REPOSITORY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaNotetakerSummaryRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { PrismaNotetakerSummaryRepository };
