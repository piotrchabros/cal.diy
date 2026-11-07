import { TeamWithOrganizationListDtoSchema } from "@calcom/lib/dto/TeamWithOrganizationDto";
import { organizationsFeatureMiddleware } from "../../../../middlewares/organizationsFeatureMiddleware";
import { authedAdminProcedure } from "../../../../procedures/authedProcedure";
import { router } from "../../../../trpc";
import { ZListTeamsPaginatedInputSchema } from "./teams.schema";

export const teamsRouter = router({
  listPaginated: authedAdminProcedure
    .use(organizationsFeatureMiddleware)
    .input(ZListTeamsPaginatedInputSchema)
    .output(TeamWithOrganizationListDtoSchema)
    .query(async ({ input }) => {
      const { getTeamRepository } = await import("@calcom/features/teams/di/TeamRepository.container");
      const { items, nextCursor, total } = await getTeamRepository().findManyPaginated({
        search: input.searchTerm,
        parentId: input.organizationId,
        cursor: input.cursor,
        limit: input.limit,
      });
      return { rows: items, nextCursor, meta: { totalRowCount: total } };
    }),
});
