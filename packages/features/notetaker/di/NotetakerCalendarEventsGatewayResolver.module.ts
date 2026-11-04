import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  GoogleCalendarEventsGateway,
  type IGoogleCalendarEventsGatewayDeps,
} from "@calcom/features/notetaker/calendar/GoogleCalendarEventsGateway";
import type { INotetakerCalendarEventsGatewayResolver } from "@calcom/features/notetaker/calendar/INotetakerCalendarEventsGateway";
import {
  GOOGLE_CALENDAR_INTEGRATION,
  NotetakerCalendarEventsGatewayResolver,
} from "@calcom/features/notetaker/calendar/NotetakerCalendarEventsGatewayResolver";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_EVENTS_GATEWAY_RESOLVER;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_EVENTS_GATEWAY_RESOLVER_MODULE;

// Dynamic import keeps the Google SDK and the credential repository out of every bundle that loads this
// module until a calendar is actually polled.
const getGoogleEventsClient: IGoogleCalendarEventsGatewayDeps["getEventsClient"] = async (calendar) => {
  const { getNotetakerGoogleEventsListClient } = await import("../calendar/googleEventsClient");
  return getNotetakerGoogleEventsListClient(calendar);
};

thisModule.bind(token).toFactory(
  (): INotetakerCalendarEventsGatewayResolver =>
    new NotetakerCalendarEventsGatewayResolver({
      gateways: {
        [GOOGLE_CALENDAR_INTEGRATION]: new GoogleCalendarEventsGateway({
          getEventsClient: getGoogleEventsClient,
        }),
      },
    }),
  "singleton"
);

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
