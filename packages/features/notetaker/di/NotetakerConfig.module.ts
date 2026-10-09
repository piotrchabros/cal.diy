import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { getNotetakerConfig } from "@calcom/features/notetaker/lib/config";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CONFIG;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CONFIG_MODULE;

// A value, not a class, so it cannot go through bindModuleToClassOnToken. Singleton so the
// environment is parsed once per container; an invalid NOTETAKER_* variable throws on first resolve.
thisModule.bind(token).toFactory(() => getNotetakerConfig(), "singleton");

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
