import { getExternalCalendarEventsService } from "@calcom/features/external-calendar-events/di/ExternalCalendarEventsService.container";
import type { ExternalCalendarEventsDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TExternalCalendarEventsInputSchema } from "./externalCalendarEvents.schema";

type ExternalCalendarEventsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TExternalCalendarEventsInputSchema;
};

export const externalCalendarEventsHandler = async ({
  ctx,
  input,
}: ExternalCalendarEventsOptions): Promise<ExternalCalendarEventsDto> => {
  return getExternalCalendarEventsService().list({
    userId: ctx.user.id,
    userEmail: ctx.user.email,
    from: input.from,
    to: input.to,
  });
};
