import {
  OrganizationDtoSchema,
  OrganizationListResultDtoSchema,
  OrganizationTeamListDtoSchema,
} from "@calcom/lib/dto/OrganizationDto";
import {
  MoveTeamPreviewDtoSchema,
  MoveTeamResultDtoSchema,
  MoveUserResultDtoSchema,
} from "@calcom/lib/dto/OrganizationMoveDto";
import { organizationsFeatureMiddleware } from "../../../../middlewares/organizationsFeatureMiddleware";
import { authedAdminProcedure } from "../../../../procedures/authedProcedure";
import { router } from "../../../../trpc";
import {
  ZCreateOrganizationInput,
  ZDeleteOrganizationInput,
  ZDeleteOrganizationOutput,
  ZGetOrganizationInput,
  ZListOrganizationsInput,
  ZListOrganizationTeamsInput,
  ZMoveTeamInput,
  ZMoveUserInput,
  ZPreviewMoveTeamInput,
  ZUpdateOrganizationInput,
} from "./organizations.schema";

const organizationsProcedure = authedAdminProcedure.use(organizationsFeatureMiddleware);

const loadService = async () => {
  const { getOrganizationService } = await import(
    "@calcom/features/organizations/di/OrganizationService.container"
  );
  return getOrganizationService();
};

const loadMoveService = async () => {
  const { getOrganizationMoveService } = await import(
    "@calcom/features/organizations/di/OrganizationMoveService.container"
  );
  return getOrganizationMoveService();
};

export const organizationsRouter = router({
  list: organizationsProcedure
    .input(ZListOrganizationsInput)
    .output(OrganizationListResultDtoSchema)
    .query(async ({ input }) => {
      const service = await loadService();
      return service.list(input);
    }),
  get: organizationsProcedure
    .input(ZGetOrganizationInput)
    .output(OrganizationDtoSchema)
    .query(async ({ input }) => {
      const service = await loadService();
      return service.get(input.id);
    }),
  create: organizationsProcedure
    .input(ZCreateOrganizationInput)
    .output(OrganizationDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadService();
      return service.create(input, ctx.user.id, ctx.user.name);
    }),
  update: organizationsProcedure
    .input(ZUpdateOrganizationInput)
    .output(OrganizationDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      const service = await loadService();
      return service.update(id, rest, ctx.user.id);
    }),
  delete: organizationsProcedure
    .input(ZDeleteOrganizationInput)
    .output(ZDeleteOrganizationOutput)
    .mutation(async ({ ctx, input }) => {
      const service = await loadService();
      return service.delete(input.id, ctx.user.id);
    }),
  moveUser: organizationsProcedure
    .input(ZMoveUserInput)
    .output(MoveUserResultDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadMoveService();
      return service.moveUser(input, ctx.user.id);
    }),
  previewMoveTeam: organizationsProcedure
    .input(ZPreviewMoveTeamInput)
    .output(MoveTeamPreviewDtoSchema)
    .query(async ({ input }) => {
      const service = await loadMoveService();
      return service.previewMoveTeam(input);
    }),
  moveTeam: organizationsProcedure
    .input(ZMoveTeamInput)
    .output(MoveTeamResultDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadMoveService();
      return service.moveTeam(input, ctx.user.id);
    }),
  listTeams: organizationsProcedure
    .input(ZListOrganizationTeamsInput)
    .output(OrganizationTeamListDtoSchema)
    .query(async ({ ctx, input }) => {
      const service = await loadMoveService();
      return service.listTeams({ ...input, actorUserId: ctx.user.id });
    }),
});
