import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as prismaModuleLoader } from "@calcom/features/di/modules/Prisma";
import { ORGANIZATIONS_DI_TOKENS } from "@calcom/features/organizations/di/tokens";
import { PrismaOrganizationSmtpSettingsRepository } from "@calcom/features/organizations/repositories/PrismaOrganizationSmtpSettingsRepository";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SMTP_SETTINGS_REPOSITORY;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SMTP_SETTINGS_REPOSITORY_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: PrismaOrganizationSmtpSettingsRepository,
  dep: prismaModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { PrismaOrganizationSmtpSettingsRepository };
