import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import type { OrganizationsConfig } from "../services/OrganizationService";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATIONS_CONFIG;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATIONS_CONFIG_MODULE;

// A value, not a class, so it cannot go through bindModuleToClassOnToken.
thisModule
  .bind(token)
  .toFactory(
    (): OrganizationsConfig => ({ defaultDomain: normalizeHost(new URL(WEBAPP_URL).host) }),
    "singleton"
  );

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
