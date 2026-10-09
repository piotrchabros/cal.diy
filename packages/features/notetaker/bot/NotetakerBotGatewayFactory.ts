import type { NotetakerBotProviderDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import { FakeBotGateway } from "./FakeBotGateway";
import type { INotetakerBotGateway, NotetakerBotEventSink } from "./INotetakerBotGateway";
import { SelfHostedBotGateway } from "./SelfHostedBotGateway";

export interface INotetakerBotGatewayFactoryDeps {
  config: NotetakerConfig;
  eventSink: NotetakerBotEventSink;
}

export class NotetakerBotGatewayFactory {
  constructor(private readonly deps: INotetakerBotGatewayFactoryDeps) {}

  create(): {
    gateway: INotetakerBotGateway;
    provider: Extract<NotetakerBotProviderDto, "SELF_HOSTED" | "FAKE">;
  } {
    const { config, eventSink } = this.deps;

    if (config.botProvider === null) {
      throw ErrorWithCode.Factory.InternalServerError(
        "Notetaker bot provider is not configured: set NOTETAKER_BOT_PROVIDER"
      );
    }

    if (config.botProvider === "RECALL") {
      throw ErrorWithCode.Factory.InternalServerError("Notetaker bot provider recall is not built in v1");
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
