import Anthropic from "@anthropic-ai/sdk";
import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type ISimpleLogger,
  moduleLoader as loggerModuleLoader,
} from "@calcom/features/di/shared/services/logger.service";
import { ClaudeMeetingAgent } from "../agent/ClaudeMeetingAgent";
import type { IMeetingAgent } from "../agent/IMeetingAgent";
import { isNotetakerAgentUsable, type NotetakerConfig } from "../lib/config";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.NOTETAKER_MEETING_AGENT;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_MEETING_AGENT_MODULE;

function createNotetakerMeetingAgent(params: {
  config: NotetakerConfig;
  logger: ISimpleLogger;
}): IMeetingAgent | null {
  const { config, logger } = params;
  if (!isNotetakerAgentUsable(config)) {
    if (config.agent.enabled) {
      // Booleans only: the prerequisites include secrets that must never reach the logs.
      logger.warn("Notetaker meeting agent is enabled but not usable", {
        botProviderIsRecall: config.botProvider === "RECALL",
        hasRecallConfig: config.recall !== null,
        hasAnthropicApiKey: Boolean(config.anthropicApiKey),
      });
    }
    return null;
  }

  // A live meeting is waiting on the reply, so fail fast rather than retry a slow call repeatedly.
  return new ClaudeMeetingAgent({
    client: new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1, timeout: 60_000 }),
    model: config.agent.model,
    logger,
  });
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);
  loggerModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule.bind(token).toFactory(
    () =>
      createNotetakerMeetingAgent({
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

export { createNotetakerMeetingAgent };
