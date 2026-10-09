import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { NOTETAKER_DI_TOKENS } from "@calcom/features/notetaker/di/tokens";
import { PrismaNotetakerTranscriptRepository } from "@calcom/features/notetaker/repositories/PrismaNotetakerTranscriptRepository";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_TRANSCRIPT_REPOSITORY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_TRANSCRIPT_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaNotetakerTranscriptRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { PrismaNotetakerTranscriptRepository };
