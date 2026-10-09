import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import type { NotetakerEventTypeDefaultDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TGetEventTypeDefaultInputSchema } from "./getEventTypeDefault.schema";

type GetEventTypeDefaultOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetEventTypeDefaultInputSchema;
};

export const getEventTypeDefaultHandler = async ({
  ctx,
  input,
}: GetEventTypeDefaultOptions): Promise<NotetakerEventTypeDefaultDto> => {
  return getNotetakerChoiceService().getEventTypeDefault({
    eventTypeId: input.eventTypeId,
    userId: ctx.user.id,
  });
};
