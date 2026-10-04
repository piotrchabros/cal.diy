import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import { ZCreateInputSchema } from "./create.schema";
import { ZIsSlugAvailableInputSchema } from "./isSlugAvailable.schema";

type TeamsRouterHandlerCache = {
  create?: typeof import("./create.handler").createHandler;
  isSlugAvailable?: typeof import("./isSlugAvailable.handler").isSlugAvailableHandler;
};

export const teamsRouter = router({
  create: authedProcedure.input(ZCreateInputSchema).mutation(async ({ ctx, input }) => {
    const { createHandler } = await import("./create.handler");

    return createHandler({
      ctx,
      input,
    });
  }),

  isSlugAvailable: authedProcedure.input(ZIsSlugAvailableInputSchema).query(async ({ input }) => {
    const { isSlugAvailableHandler } = await import("./isSlugAvailable.handler");

    return isSlugAvailableHandler({
      input,
    });
  }),
});
