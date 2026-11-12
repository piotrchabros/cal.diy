import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { OrganizationEmailSenderService } from "@calcom/features/organizations/services/OrganizationEmailSenderService";
import { moduleLoader as organizationEmailSenderConfigModuleLoader } from "./OrganizationEmailSenderConfig.module";
import { moduleLoader as organizationMembershipServiceModuleLoader } from "./OrganizationMembershipService.module";
import { moduleLoader as organizationEmailSenderRepositoryModuleLoader } from "./PrismaOrganizationEmailSenderRepository.module";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_EMAIL_SENDER_SERVICE;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_EMAIL_SENDER_SERVICE_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: OrganizationEmailSenderService,
  depsMap: {
    emailSenderRepository: organizationEmailSenderRepositoryModuleLoader,
    organizationMembershipService: organizationMembershipServiceModuleLoader,
    emailSenderConfig: organizationEmailSenderConfigModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { OrganizationEmailSenderService };
