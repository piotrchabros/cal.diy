import Anthropic from "@anthropic-ai/sdk";
import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type ISimpleLogger,
  moduleLoader as loggerModuleLoader,
} from "@calcom/features/di/shared/services/logger.service";
import { getNotetakerSummaryGeneratorKind, type NotetakerConfig } from "../lib/config";
import { AnthropicSummaryGenerator } from "../summary/AnthropicSummaryGenerator";
import { DisabledSummaryGenerator } from "../summary/DisabledSummaryGenerator";
import type { INotetakerSummaryGenerator } from "../summary/INotetakerSummaryGenerator";
import { StubSummaryGenerator } from "../summary/StubSummaryGenerator";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_GENERATOR;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_SUMMARY_GENERATOR_MODULE;

function createNotetakerSummaryGenerator(params: {
  config: NotetakerConfig;
  logger: ISimpleLogger;
  env?: NodeJS.ProcessEnv;
}): INotetakerSummaryGenerator {
  const { config, logger, env } = params;
  switch (getNotetakerSummaryGeneratorKind(config, env)) {
    case "ANTHROPIC":
      return new AnthropicSummaryGenerator({
        client: new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2 }),
        model: config.summaryModel,
        logger,
      });
    case "STUB":
      logger.info("Notetaker summary generator: stub (ANTHROPIC_API_KEY unset)");
      return new StubSummaryGenerator();
    case "DISABLED":
      logger.error("Notetaker summary generator disabled: ANTHROPIC_API_KEY is unset in production");
      return new DisabledSummaryGenerator();
  }
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);
  loggerModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule.bind(token).toFactory(
    () =>
      createNotetakerSummaryGenerator({
        config: container.get<NotetakerConfig>(configModuleLoader.token),
        logger: container.get<ISimpleLogger>(loggerModuleLoader.token),
      }),
    "singleton"
  );

  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export { createNotetakerSummaryGenerator };
