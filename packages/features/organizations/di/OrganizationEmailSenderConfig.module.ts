import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import type { OrganizationEmailSenderConfig } from "@calcom/features/organizations/services/OrganizationEmailSenderService";
import { EMAIL_FROM_NAME } from "@calcom/lib/constants";
import { serverConfig } from "@calcom/lib/serverConfig";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_EMAIL_SENDER_CONFIG;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATION_EMAIL_SENDER_CONFIG_MODULE;

// EMAIL_FROM may be "Name <address>" or a bare address
function toBareAddress(from: string | undefined): string | null {
  if (!from) return null;
  const match = from.match(/<([^>]+)>/);
  const address = (match ? match[1] : from).trim();
  return address === "" ? null : address;
}

// A value, not a class, so it cannot go through bindModuleToClassOnToken
thisModule.bind(token).toFactory(
  (): OrganizationEmailSenderConfig => ({
    defaultName: EMAIL_FROM_NAME,
    defaultAddress: toBareAddress(serverConfig.from),
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
