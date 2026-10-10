import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import { eventOwnerProcedure } from "../eventTypes/util";
import { ZDeleteResultsInputSchema } from "./deleteResults.schema";
import { ZExportInputSchema } from "./export.schema";
import { ZGetActivityInputSchema } from "./getActivity.schema";
import { ZGetEventTypeDefaultInputSchema } from "./getEventTypeDefault.schema";
import { ZGetEventTypeSharingInputSchema } from "./getEventTypeSharing.schema";
import { ZGetStateInputSchema } from "./getState.schema";
import { ZListEventTypeSharingCandidatesInputSchema } from "./listEventTypeSharingCandidates.schema";
import { ZListPassagesInputSchema } from "./listPassages.schema";
import { ZListSharedWithMeInputSchema } from "./listSharedWithMe.schema";
import { ZRegenerateSummaryInputSchema } from "./regenerateSummary.schema";
import { ZSetEnabledInputSchema } from "./setEnabled.schema";
import { ZSetEventTypeDefaultInputSchema } from "./setEventTypeDefault.schema";
import { ZSetEventTypeSharingInputSchema } from "./setEventTypeSharing.schema";
import { ZSetSharingInputSchema } from "./setSharing.schema";
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

  getEventTypeSharing: eventOwnerProcedure
    .input(ZGetEventTypeSharingInputSchema)
    .query(async ({ ctx, input }) => {
      const { getEventTypeSharingHandler } = await import("./getEventTypeSharing.handler");
      return getEventTypeSharingHandler({ ctx, input: { eventTypeId: input.eventTypeId } });
    }),

  setEventTypeSharing: eventOwnerProcedure
    .input(ZSetEventTypeSharingInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { setEventTypeSharingHandler } = await import("./setEventTypeSharing.handler");
      return setEventTypeSharingHandler({
        ctx,
        input: { eventTypeId: input.eventTypeId, mode: input.mode, userIds: input.userIds },
      });
    }),

  listEventTypeSharingCandidates: eventOwnerProcedure
    .input(ZListEventTypeSharingCandidatesInputSchema)
    .query(async ({ ctx, input }) => {
      const { listEventTypeSharingCandidatesHandler } = await import(
        "./listEventTypeSharingCandidates.handler"
      );
      return listEventTypeSharingCandidatesHandler({
        ctx,
        input: {
          eventTypeId: input.eventTypeId,
          search: input.search,
          cursor: input.cursor,
          limit: input.limit,
        },
      });
    }),

  listSharedWithMe: authedProcedure.input(ZListSharedWithMeInputSchema).query(async ({ ctx, input }) => {
    const { listSharedWithMeHandler } = await import("./listSharedWithMe.handler");
    return listSharedWithMeHandler({ ctx, input });
  }),

  setSharing: authedProcedure.input(ZSetSharingInputSchema).mutation(async ({ ctx, input }) => {
    const { setSharingHandler } = await import("./setSharing.handler");
    return setSharingHandler({ ctx, input });
  }),

  deleteResults: authedProcedure.input(ZDeleteResultsInputSchema).mutation(async ({ ctx, input }) => {
    const { deleteResultsHandler } = await import("./deleteResults.handler");
    return deleteResultsHandler({ ctx, input });
  }),

  export: authedProcedure.input(ZExportInputSchema).mutation(async ({ ctx, input }) => {
    const { exportHandler } = await import("./export.handler");
    return exportHandler({ ctx, input });
  }),

  getActivity: authedProcedure.input(ZGetActivityInputSchema).query(async ({ ctx, input }) => {
    const { getActivityHandler } = await import("./getActivity.handler");
    return getActivityHandler({ ctx, input });
  }),
});
