import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  GoogleCalendarGuestGateway,
  type IGoogleCalendarGuestGatewayDeps,
} from "@calcom/features/notetaker/calendar/GoogleCalendarGuestGateway";
import type { INotetakerCalendarGuestGateway } from "@calcom/features/notetaker/calendar/INotetakerCalendarGuestGateway";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_GUEST_GATEWAY;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_GUEST_GATEWAY_MODULE;

// Dynamic import keeps the Google SDK and the credential repository out of every bundle that loads the
// dispatch container (the Trigger.dev task, the cron route, the setEnabled handler) until an invite runs.
const getEventsClient: IGoogleCalendarGuestGatewayDeps["getEventsClient"] = async (credentialId) => {
  const { getNotetakerGoogleEventsClient } = await import("../calendar/googleEventsClient");
  return getNotetakerGoogleEventsClient(credentialId);
};

thisModule
  .bind(token)
  .toFactory(
    (): INotetakerCalendarGuestGateway => new GoogleCalendarGuestGateway({ getEventsClient }),
    "singleton"
  );

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
