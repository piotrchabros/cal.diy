import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import {
  ZDisbandTeamInputSchema,
  ZGetTeamProfileInputSchema,
  ZUpdateTeamProfileInputSchema,
} from "./teamProfile.schema";

export const teamsRouter = router({
  getProfile: authedProcedure.input(ZGetTeamProfileInputSchema).query(async ({ ctx, input }) => {
    const handler = (await import("./get.handler")).getTeamProfileHandler;
    return handler({ ctx, input });
  }),
  updateProfile: authedProcedure.input(ZUpdateTeamProfileInputSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./update.handler")).updateTeamProfileHandler;
    return handler({ ctx, input });
  }),
  disband: authedProcedure.input(ZDisbandTeamInputSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./disband.handler")).disbandTeamHandler;
    return handler({ ctx, input });
  }),
});
