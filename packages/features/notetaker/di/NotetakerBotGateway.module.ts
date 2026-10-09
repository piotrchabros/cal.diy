import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type ISimpleLogger,
  moduleLoader as loggerModuleLoader,
} from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import type { INotetakerBotGatewayResolver, NotetakerBotGatewayBinding } from "../bot/INotetakerBotGateway";
import { NotetakerBotGatewayFactory } from "../bot/NotetakerBotGatewayFactory";
import { isNotetakerBotProviderUsable, type NotetakerConfig } from "../lib/config";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.NOTETAKER_BOT_GATEWAY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_BOT_GATEWAY_MODULE;

const eventSink = async (event: NotetakerBotEvent): Promise<void> => {
  // Dynamic import keeps the gateway free of a static edge to the event service, so no DI cycle can form.
  const { getNotetakerSessionEventService } = await import("./NotetakerSessionEventService.container");
  await getNotetakerSessionEventService().handleEvent(event);
};

function createBinding(container: Container): NotetakerBotGatewayBinding | null {
  const logger = container.get<ISimpleLogger>(loggerModuleLoader.token);
  try {
    const config = container.get<NotetakerConfig>(configModuleLoader.token);
    if (!isNotetakerBotProviderUsable(config)) {
      logger.error("Notetaker bot provider is not usable");
      return null;
    }
    return new NotetakerBotGatewayFactory({ config, eventSink }).create();
  } catch (error) {
    // Message only: the config holds the bot URL and secret.
    logger.error("Notetaker bot gateway could not be created", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);
  loggerModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule.bind(token).toFactory((): INotetakerBotGatewayResolver => {
    let resolved = false;
    let binding: NotetakerBotGatewayBinding | null = null;
    return {
      resolve() {
        if (resolved) return binding;
        resolved = true;
        binding = createBinding(container);
        return binding;
      },
    };
  }, "singleton");

  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
