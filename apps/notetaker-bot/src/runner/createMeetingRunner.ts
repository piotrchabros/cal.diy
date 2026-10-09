import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import { EventSender } from "../callback/EventSender";
import type { RunnerConfig } from "../config";
import type { Logger } from "../logger";
import { PlaywrightChromeLauncher } from "../platform/browser/PlaywrightChromeLauncher";
import { GoogleMeetAdapter } from "../platform/GoogleMeetAdapter";
import { MicrosoftTeamsAdapter } from "../platform/MicrosoftTeamsAdapter";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import { SpeakerAttributor } from "../speakers/SpeakerAttributor";
import { SonioxRealtimeProvider } from "../stt/SonioxRealtimeProvider";
import type { SpeechToTextProvider } from "../stt/SpeechToTextProvider";
import { createFakeMeeting } from "./fakeMeeting";
import { MeetingRunner } from "./MeetingRunner";

type Collaborators = { platform: PlatformAdapter; stt: SpeechToTextProvider };

function createCollaborators(
  request: NotetakerBotJoinRequest,
  config: RunnerConfig,
  logger: Logger
): Collaborators {
  if (config.adapterMode === "fake") {
    return createFakeMeeting({ platform: request.platform, meetingMs: config.fakeMeetingSeconds * 1000 });
  }

  const { soniox } = config;
  if (soniox === null) {
    throw new Error("Real adapter mode needs SONIOX_API_KEY");
  }

  const stt = new SonioxRealtimeProvider({
    apiKey: soniox.apiKey,
    url: soniox.url ?? undefined,
    model: soniox.model ?? undefined,
    logger,
  });
  const browser = new PlaywrightChromeLauncher({ logger });

  switch (request.platform) {
    case "GOOGLE_MEET":
      return {
        platform: new GoogleMeetAdapter({ browser, google: config.google, chrome: config.chrome, logger }),
        stt,
      };
    case "MICROSOFT_TEAMS":
      return { platform: new MicrosoftTeamsAdapter({ browser, chrome: config.chrome, logger }), stt };
  }
}

export function createMeetingRunner(input: {
  request: NotetakerBotJoinRequest;
  config: RunnerConfig;
  logger: Logger;
  fetchFn?: typeof fetch;
}): MeetingRunner {
  const { request, config, logger } = input;
  const { platform, stt } = createCollaborators(request, config, logger);

  // The sender is built first because the runner takes it in its deps. onStopped fires only after a
  // delivery attempt, and only the started runner enqueues, so the runner exists by then.
  let runner: MeetingRunner | undefined;
  const sender = new EventSender({
    sessionId: request.sessionId,
    callbackUrl: request.callbackUrl,
    secret: config.secret,
    onStopped: (cause) => runner?.handleSenderStopped(cause),
    logger,
    fetchFn: input.fetchFn,
  });

  runner = new MeetingRunner({ request, platform, stt, attributor: new SpeakerAttributor(), sender, logger });
  return runner;
}
