import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import { eventOwnerProcedure } from "../eventTypes/util";
import { ZGetEventTypeDefaultInputSchema } from "./getEventTypeDefault.schema";
import { ZGetStateInputSchema } from "./getState.schema";
import { ZListPassagesInputSchema } from "./listPassages.schema";
import { ZRegenerateSummaryInputSchema } from "./regenerateSummary.schema";
import { ZSetEnabledInputSchema } from "./setEnabled.schema";
import { ZSetEventTypeDefaultInputSchema } from "./setEventTypeDefault.schema";
import { ZStopInputSchema } from "./stop.schema";

export const notetakerRouter = router({
  getState: authedProcedure.input(ZGetStateInputSchema).query(async ({ ctx, input }) => {
    const { getStateHandler } = await import("./getState.handler");
    return getStateHandler({ ctx, input });
  }),

  setEnabled: authedProcedure.input(ZSetEnabledInputSchema).mutation(async ({ ctx, input }) => {
    const { setEnabledHandler } = await import("./setEnabled.handler");
    return setEnabledHandler({ ctx, input });
  }),

  stop: authedProcedure.input(ZStopInputSchema).mutation(async ({ ctx, input }) => {
    const { stopHandler } = await import("./stop.handler");
    return stopHandler({ ctx, input });
  }),

  listPassages: authedProcedure.input(ZListPassagesInputSchema).query(async ({ ctx, input }) => {
    const { listPassagesHandler } = await import("./listPassages.handler");
    return listPassagesHandler({ ctx, input });
  }),

  regenerateSummary: authedProcedure.input(ZRegenerateSummaryInputSchema).mutation(async ({ ctx, input }) => {
    const { regenerateSummaryHandler } = await import("./regenerateSummary.handler");
    return regenerateSummaryHandler({ ctx, input });
  }),

  getEventTypeDefault: eventOwnerProcedure
    .input(ZGetEventTypeDefaultInputSchema)
    .query(async ({ ctx, input }) => {
      const { getEventTypeDefaultHandler } = await import("./getEventTypeDefault.handler");
      return getEventTypeDefaultHandler({ ctx, input: { eventTypeId: input.eventTypeId } });
    }),

  setEventTypeDefault: eventOwnerProcedure
    .input(ZSetEventTypeDefaultInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { setEventTypeDefaultHandler } = await import("./setEventTypeDefault.handler");
      return setEventTypeDefaultHandler({
        ctx,
        input: { eventTypeId: input.eventTypeId, enabledByDefault: input.enabledByDefault },
      });
    }),
});
