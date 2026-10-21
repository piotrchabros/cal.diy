import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import { FakeBotGateway } from "./FakeBotGateway";
import type { NotetakerBotEventSink, NotetakerBotGatewayBinding } from "./INotetakerBotGateway";
import { RecallApiClient } from "./recall/RecallApiClient";
import { RecallBotGateway } from "./recall/RecallBotGateway";
import { getRecallLivenessTimeoutSeconds } from "./recall/recallEventTranslation";
import { SelfHostedBotGateway } from "./SelfHostedBotGateway";

export interface INotetakerBotGatewayFactoryDeps {
  config: NotetakerConfig;
  eventSink: NotetakerBotEventSink;
  findExternalRef: (sessionId: string) => Promise<string | null>;
}

export class NotetakerBotGatewayFactory {
  constructor(private readonly deps: INotetakerBotGatewayFactoryDeps) {}

  create(): NotetakerBotGatewayBinding {
    const { config, eventSink, findExternalRef } = this.deps;

    if (config.botProvider === null) {
      throw ErrorWithCode.Factory.InternalServerError(
        "Notetaker bot provider is not configured: set NOTETAKER_BOT_PROVIDER"
      );
    }

    if (config.botProvider === "RECALL") {
      if (config.recall === null) {
        throw ErrorWithCode.Factory.InternalServerError(
          "Notetaker recall provider needs RECALL_API_KEY and RECALL_WEBHOOK_VERIFICATION_SECRET"
        );
      }
      const { apiKey, region } = config.recall;
      return {
        gateway: new RecallBotGateway({ client: new RecallApiClient({ apiKey, region }), findExternalRef }),
        provider: "RECALL",
        livenessTimeoutSeconds: getRecallLivenessTimeoutSeconds(config.limits),
      };
    }

    if (config.botProvider === "SELF_HOSTED") {
      const { botUrl, botSecret } = config;
      if (botUrl === null || botSecret === null) {
        throw ErrorWithCode.Factory.InternalServerError(
          "Notetaker self_hosted provider needs NOTETAKER_BOT_URL and NOTETAKER_BOT_SECRET"
        );
      }
      return { gateway: new SelfHostedBotGateway({ botUrl, botSecret }), provider: "SELF_HOSTED" };
    }

    if (!isNotetakerBotProviderUsable(config)) {
      throw ErrorWithCode.Factory.InternalServerError(
        "Notetaker fake provider is not allowed in production without NEXT_PUBLIC_IS_E2E"
      );
    }
    return { gateway: new FakeBotGateway({ scenario: config.fakeScenario, eventSink }), provider: "FAKE" };
  }
}
