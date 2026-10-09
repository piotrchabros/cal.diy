import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import { ZGetStateInputSchema } from "./getState.schema";
import { ZListPassagesInputSchema } from "./listPassages.schema";
import { ZSetEnabledInputSchema } from "./setEnabled.schema";

export const notetakerRouter = router({
  getState: authedProcedure.input(ZGetStateInputSchema).query(async ({ ctx, input }) => {
    const { getStateHandler } = await import("./getState.handler");
    return getStateHandler({ ctx, input });
  }),

  setEnabled: authedProcedure.input(ZSetEnabledInputSchema).mutation(async ({ ctx, input }) => {
    const { setEnabledHandler } = await import("./setEnabled.handler");
    return setEnabledHandler({ ctx, input });
  }),

  listPassages: authedProcedure.input(ZListPassagesInputSchema).query(async ({ ctx, input }) => {
    const { listPassagesHandler } = await import("./listPassages.handler");
    return listPassagesHandler({ ctx, input });
  }),
});
