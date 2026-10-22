import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import type { NotetakerBotProviderDto } from "@calcom/lib/dto/NotetakerStateDto";
import type {
  INotetakerRecordingMediaGateway,
  INotetakerRecordingMediaGatewayResolver,
} from "../bot/INotetakerRecordingMediaGateway";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { RecallRecordingMediaGateway } from "../bot/recall/RecallRecordingMediaGateway";
import type { NotetakerConfig } from "../lib/config";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as recallApiClientModuleLoader } from "./RecallApiClient.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.NOTETAKER_RECORDING_MEDIA_GATEWAY_RESOLVER;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_RECORDING_MEDIA_GATEWAY_RESOLVER_MODULE;

function createNotetakerRecordingMediaGatewayResolver(params: {
  config: NotetakerConfig;
  // Lazy because the client factory throws when Recall is unconfigured.
  getRecallClient: () => IRecallApiClient;
}): INotetakerRecordingMediaGatewayResolver {
  const { config, getRecallClient } = params;
  return {
    forProvider(provider: NotetakerBotProviderDto): INotetakerRecordingMediaGateway | null {
      if (provider !== "RECALL" || !config.recall) return null;
      return new RecallRecordingMediaGateway({ client: getRecallClient() });
    },
  };
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);
  recallApiClientModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule.bind(token).toFactory(
    () =>
      createNotetakerRecordingMediaGatewayResolver({
        config: container.get<NotetakerConfig>(configModuleLoader.token),
        getRecallClient: () => container.get<IRecallApiClient>(recallApiClientModuleLoader.token),
      }),
    "singleton"
  );

  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export { createNotetakerRecordingMediaGatewayResolver };
