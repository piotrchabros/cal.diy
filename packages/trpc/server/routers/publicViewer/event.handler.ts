import type { IncomingHttpHeaders } from "node:http";
import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import type { TEventInputSchema } from "./event.schema";

interface EventHandlerOptions {
  input: TEventInputSchema;
  userId?: number;
  headers?: IncomingHttpHeaders;
}

export const eventHandler = async ({ input, userId, headers }: EventHandlerOptions) => {
  // The client-supplied org is untrusted: like the booking pages, the event is looked up in the
  // organization of the request host so a booking page can't load another organization's event.
  if (!headers) return await EventRepository.getPublicEvent(input, userId);

  const host = await getHostOrganization(headers);
  if (host.status === "disabled") return await EventRepository.getPublicEvent(input, userId);
  if (host.status === "unresolved") return null;

  return await EventRepository.getPublicEvent({ ...input, org: host.org.slug }, userId);
};

export default eventHandler;
