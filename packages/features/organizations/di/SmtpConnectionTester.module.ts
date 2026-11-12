import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type ISmtpConnectionTester,
  NodemailerSmtpConnectionTester,
} from "@calcom/features/organizations/lib/SmtpConnectionTester";
import { ORGANIZATIONS_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = ORGANIZATIONS_DI_TOKENS.SMTP_CONNECTION_TESTER;
const moduleToken = ORGANIZATIONS_DI_TOKENS.SMTP_CONNECTION_TESTER_MODULE;

// Stateless and dependency-free, so it is bound as a value rather than through bindModuleToClassOnToken
thisModule
  .bind(token)
  .toFactory((): ISmtpConnectionTester => new NodemailerSmtpConnectionTester(), "singleton");

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
