import type {
  INotetakerCalendarEventsGateway,
  INotetakerCalendarEventsGatewayResolver,
} from "./INotetakerCalendarEventsGateway";

export const GOOGLE_CALENDAR_INTEGRATION = "google_calendar";

export interface INotetakerCalendarEventsGatewayResolverDeps {
  /** Keyed by SelectedCalendar.integration */
  gateways: Readonly<Record<string, INotetakerCalendarEventsGateway>>;
}

export class NotetakerCalendarEventsGatewayResolver implements INotetakerCalendarEventsGatewayResolver {
  constructor(private readonly deps: INotetakerCalendarEventsGatewayResolverDeps) {}

  resolve(integration: string): INotetakerCalendarEventsGateway | null {
    if (!Object.hasOwn(this.deps.gateways, integration)) return null;
    return this.deps.gateways[integration];
  }

  supportedIntegrations(): string[] {
    return Object.keys(this.deps.gateways);
  }
}
