import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationSmtpSettingsService } from "@calcom/features/organizations/services/OrganizationSmtpSettingsService";
import { moduleLoader as organizationEmailSenderServiceModuleLoader } from "./OrganizationEmailSenderService.module";
import { moduleLoader as organizationMembershipServiceModuleLoader } from "./OrganizationMembershipService.module";
import { moduleLoader as organizationSmtpConfigModuleLoader } from "./OrganizationSmtpConfig.module";
import { moduleLoader as smtpSettingsRepositoryModuleLoader } from "./PrismaOrganizationSmtpSettingsRepository.module";
import { moduleLoader as smtpConnectionTesterModuleLoader } from "./SmtpConnectionTester.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SMTP_SETTINGS_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SMTP_SETTINGS_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationSmtpSettingsService,
  depsMap: {
    smtpSettingsRepository: smtpSettingsRepositoryModuleLoader,
    organizationMembershipService: organizationMembershipServiceModuleLoader,
    emailSenderService: organizationEmailSenderServiceModuleLoader,
    connectionTester: smtpConnectionTesterModuleLoader,
    smtpConfig: organizationSmtpConfigModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationSmtpSettingsService };
