import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import type { NotetakerDisclosureDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TNotetakerDisclosureInputSchema } from "./notetakerDisclosure.schema";

export const notetakerDisclosureHandler = async ({
  input,
}: {
  input: TNotetakerDisclosureInputSchema;
}): Promise<NotetakerDisclosureDto> => {
  return getNotetakerChoiceService().getDisclosure({ eventTypeId: input.eventTypeId });
};

export default notetakerDisclosureHandler;
