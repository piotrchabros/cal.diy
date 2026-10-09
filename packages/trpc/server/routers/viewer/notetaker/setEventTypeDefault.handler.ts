import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import type { NotetakerEventTypeDefaultDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TSetEventTypeDefaultInputSchema } from "./setEventTypeDefault.schema";

type SetEventTypeDefaultOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetEventTypeDefaultInputSchema;
};

export const setEventTypeDefaultHandler = async ({
  ctx,
  input,
}: SetEventTypeDefaultOptions): Promise<NotetakerEventTypeDefaultDto> => {
  return getNotetakerChoiceService().setEventTypeDefault({
    eventTypeId: input.eventTypeId,
    enabledByDefault: input.enabledByDefault,
    userId: ctx.user.id,
  });
};
