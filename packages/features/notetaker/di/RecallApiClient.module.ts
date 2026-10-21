import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { ErrorWithCode } from "@calcom/lib/errors";
import { type IRecallApiClient, RecallApiClient } from "../bot/recall/RecallApiClient";
import type { NotetakerConfig } from "../lib/config";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.RECALL_API_CLIENT;
const moduleToken = NOTETAKER_DI_TOKENS.RECALL_API_CLIENT_MODULE;

function createRecallApiClient(config: NotetakerConfig): IRecallApiClient {
  if (!config.recall) {
    throw ErrorWithCode.Factory.InternalServerError("Recall is not configured");
  }
  return new RecallApiClient({ apiKey: config.recall.apiKey, region: config.recall.region });
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule
    .bind(token)
    .toFactory(
      () => createRecallApiClient(container.get<NotetakerConfig>(configModuleLoader.token)),
      "singleton"
    );

  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
