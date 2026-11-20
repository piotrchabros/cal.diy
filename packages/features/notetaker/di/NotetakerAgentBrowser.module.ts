import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type ISimpleLogger,
  moduleLoader as loggerModuleLoader,
} from "@calcom/features/di/shared/services/logger.service";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { HttpAgentBrowserGateway } from "../browser/HttpAgentBrowserGateway";
import { MeetingAgentBrowserService } from "../browser/MeetingAgentBrowserService";
import { isNotetakerAgentBrowserUsable, isNotetakerAgentUsable, type NotetakerConfig } from "../lib/config";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { moduleLoader as recallApiClientModuleLoader } from "./RecallApiClient.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.NOTETAKER_AGENT_BROWSER;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_AGENT_BROWSER_MODULE;

// The viewer token must outlive the longest meeting the bot may stay in, plus slack for a late share.
const VIEWER_TOKEN_TTL_MARGIN_SECONDS = 600;

function createNotetakerAgentBrowser(params: {
  config: NotetakerConfig;
  logger: ISimpleLogger;
  // Lazy because the Recall client factory throws when Recall is not configured, which is the disabled case.
  getRecallClient: () => IRecallApiClient;
}): MeetingAgentBrowserService | null {
  const { config, logger, getRecallClient } = params;
  const { enabled, internalUrl, publicUrl, secret } = config.agentBrowser;
  if (!isNotetakerAgentBrowserUsable(config) || !internalUrl || !publicUrl || !secret) {
    if (enabled) {
      // Booleans only: the secret and internal URL must never reach the logs.
      logger.warn("Notetaker agent browser is enabled but not usable", {
        agentUsable: isNotetakerAgentUsable(config),
        hasInternalUrl: internalUrl !== null,
        hasPublicUrl: publicUrl !== null,
        hasSecret: secret !== null,
      });
    }
    return null;
  }

  return new MeetingAgentBrowserService({
    gateway: new HttpAgentBrowserGateway({
      internalUrl,
      publicUrl,
      secret,
      viewerTokenTtlSeconds: config.limits.maxDurationSeconds + VIEWER_TOKEN_TTL_MARGIN_SECONDS,
    }),
    recallClient: getRecallClient(),
    logger,
  });
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);
  loggerModuleLoader.loadModule(container);
  recallApiClientModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule.bind(token).toFactory(
    () =>
      createNotetakerAgentBrowser({
        config: container.get<NotetakerConfig>(configModuleLoader.token),
        logger: container.get<ISimpleLogger>(loggerModuleLoader.token),
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

export { createNotetakerAgentBrowser };
export type { MeetingAgentBrowserService };
