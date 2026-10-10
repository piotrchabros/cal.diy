import { z } from "zod";
import type { NotetakerSummaryStatusDto } from "./NotetakerSummaryDto";
import { NotetakerSummaryStatusDtoSchema } from "./NotetakerSummaryDto";

export type NotetakerSharedResultRouteDto = "TEAM" | "SELECTED_PEOPLE";

export type NotetakerSharedResultDto = {
  bookingUid: string;
  title: string;
  startTime: string;
  eventTypeTitle: string;
  teamName: string;
  hostName: string | null;
  route: NotetakerSharedResultRouteDto;
  summaryStatus: NotetakerSummaryStatusDto | null;
};

export const NotetakerSharedResultDtoSchema: z.ZodType<NotetakerSharedResultDto> = z.object({
  bookingUid: z.string(),
  title: z.string(),
  startTime: z.string().datetime(),
  eventTypeTitle: z.string(),
  teamName: z.string(),
  hostName: z.string().nullable(),
  route: z.enum(["TEAM", "SELECTED_PEOPLE"]),
  summaryStatus: NotetakerSummaryStatusDtoSchema.nullable(),
});

export type NotetakerSharedResultsDto = {
  items: NotetakerSharedResultDto[];
  nextCursor: string | null;
};
