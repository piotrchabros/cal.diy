import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { getDefaultOrganizationDomain } from "@calcom/lib/organizations/getOrganizationBaseUrlFromDomain";
import type { OrganizationsConfig } from "../services/OrganizationService";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.ORGANIZATIONS_CONFIG;
const moduleToken = ORGANIZATIONS_DI_TOKENS.ORGANIZATIONS_CONFIG_MODULE;

// A value, not a class, so it cannot go through bindModuleToClassOnToken.
thisModule
  .bind(token)
  .toFactory((): OrganizationsConfig => ({ defaultDomain: getDefaultOrganizationDomain() }), "singleton");

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
