import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import {
  GoogleCalendarEventsGateway,
  type IGoogleCalendarEventsGatewayDeps,
} from "@calcom/features/notetaker/calendar/GoogleCalendarEventsGateway";
import type { INotetakerCalendarEventsGatewayResolver } from "@calcom/features/notetaker/calendar/INotetakerCalendarEventsGateway";
import {
  GOOGLE_CALENDAR_INTEGRATION,
  NotetakerCalendarEventsGatewayResolver,
  OFFICE365_CALENDAR_INTEGRATION,
} from "@calcom/features/notetaker/calendar/NotetakerCalendarEventsGatewayResolver";
import {
  type IOffice365CalendarEventsGatewayDeps,
  Office365CalendarEventsGateway,
} from "@calcom/features/notetaker/calendar/Office365CalendarEventsGateway";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_EVENTS_GATEWAY_RESOLVER;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_CALENDAR_EVENTS_GATEWAY_RESOLVER_MODULE;

// Dynamic imports keep the provider SDKs and the credential repository out of every bundle that loads this
// module until a calendar is actually polled.
const getGoogleEventsClient: IGoogleCalendarEventsGatewayDeps["getEventsClient"] = async (calendar) => {
  const { getNotetakerGoogleEventsListClient } = await import("../calendar/googleEventsClient");
  return getNotetakerGoogleEventsListClient(calendar);
};

const getOffice365EventsReader: IOffice365CalendarEventsGatewayDeps["getEventsReader"] = async (calendar) => {
  const { getNotetakerOffice365EventsReader } = await import("../calendar/office365EventsClient");
  return getNotetakerOffice365EventsReader(calendar);
};

thisModule.bind(token).toFactory(
  (): INotetakerCalendarEventsGatewayResolver =>
    new NotetakerCalendarEventsGatewayResolver({
      gateways: {
        [GOOGLE_CALENDAR_INTEGRATION]: new GoogleCalendarEventsGateway({
          getEventsClient: getGoogleEventsClient,
        }),
        [OFFICE365_CALENDAR_INTEGRATION]: new Office365CalendarEventsGateway({
          getEventsReader: getOffice365EventsReader,
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
