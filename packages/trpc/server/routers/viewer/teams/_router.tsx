import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import { ZTeamGetSchema } from "./get.schema";
import { ZTeamListMembersSchema } from "./listMembers.schema";

export const teamsRouter = router({
  get: authedProcedure.input(ZTeamGetSchema).query(async ({ ctx, input }) => {
    const handler = (await import("./get.handler")).getHandler;
    return handler({ ctx, input });
  }),
  listMembers: authedProcedure.input(ZTeamListMembersSchema).query(async ({ ctx, input }) => {
    const handler = (await import("./listMembers.handler")).listMembersHandler;
    return handler({ ctx, input });
  }),
});
