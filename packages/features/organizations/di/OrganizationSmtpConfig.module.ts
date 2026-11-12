import process from "node:process";
import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import type { OrganizationSmtpConfig } from "@calcom/features/organizations/services/OrganizationSmtpSettingsService";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SMTP_CONFIG;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_SMTP_CONFIG_MODULE;

// A value, not a class, so it cannot go through bindModuleToClassOnToken
thisModule.bind(token).toFactory(
  (): OrganizationSmtpConfig => ({
    encryptionKey: process.env.CALENDSO_ENCRYPTION_KEY ?? "",
    allowPrivateHosts: process.env.ORGANIZATION_SMTP_ALLOW_PRIVATE_HOSTS === "true",
  }),
  "singleton"
);

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
