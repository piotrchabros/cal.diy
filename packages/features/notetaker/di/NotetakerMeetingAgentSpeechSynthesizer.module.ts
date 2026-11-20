import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  type ISimpleLogger,
  moduleLoader as loggerModuleLoader,
} from "@calcom/features/di/shared/services/logger.service";
import { ElevenLabsSpeechSynthesizer } from "../agent/tts/ElevenLabsSpeechSynthesizer";
import type { IMeetingAgentSpeechSynthesizer } from "../agent/tts/IMeetingAgentSpeechSynthesizer";
import { isNotetakerAgentUsable, isNotetakerAgentVoiceUsable, type NotetakerConfig } from "../lib/config";
import { moduleLoader as configModuleLoader } from "./NotetakerConfig.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const token = NOTETAKER_DI_TOKENS.NOTETAKER_MEETING_AGENT_SPEECH_SYNTHESIZER;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_MEETING_AGENT_SPEECH_SYNTHESIZER_MODULE;

function createNotetakerMeetingAgentSpeechSynthesizer(params: {
  config: NotetakerConfig;
  logger: ISimpleLogger;
}): IMeetingAgentSpeechSynthesizer | null {
  const { config, logger } = params;
  const { voice } = config.agent;
  if (!isNotetakerAgentVoiceUsable(config) || !voice.elevenLabsApiKey) {
    if (voice.elevenLabsApiKey) {
      // Booleans only: the prerequisites include secrets that must never reach the logs.
      logger.warn("Notetaker meeting agent voice is configured but not usable", {
        agentUsable: isNotetakerAgentUsable(config),
        speechProviderIsNone: config.agent.speechProvider === "NONE",
        voiceEnabled: voice.enabled,
      });
    }
    return null;
  }

  return new ElevenLabsSpeechSynthesizer({
    apiKey: voice.elevenLabsApiKey,
    voiceId: voice.voiceId,
    modelId: voice.ttsModel,
  });
}

const loadModule = (container: Container): void => {
  configModuleLoader.loadModule(container);
  loggerModuleLoader.loadModule(container);

  const thisModule = createModule();
  thisModule.bind(token).toFactory(
    () =>
      createNotetakerMeetingAgentSpeechSynthesizer({
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

export { createNotetakerMeetingAgentSpeechSynthesizer };
