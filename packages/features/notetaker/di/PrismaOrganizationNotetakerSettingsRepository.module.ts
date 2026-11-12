import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { PrismaOrganizationNotetakerSettingsRepository } from "@calcom/features/notetaker/repositories/PrismaOrganizationNotetakerSettingsRepository";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.ORGANIZATION_NOTETAKER_SETTINGS_REPOSITORY;
const moduleToken = NOTETAKER_DI_TOKENS.ORGANIZATION_NOTETAKER_SETTINGS_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaOrganizationNotetakerSettingsRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
