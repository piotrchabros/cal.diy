import { OrganizationDtoSchema, OrganizationListResultDtoSchema } from "@calcom/lib/dto/OrganizationDto";
import { organizationsFeatureMiddleware } from "../../../../middlewares/organizationsFeatureMiddleware";
import { authedAdminProcedure } from "../../../../procedures/authedProcedure";
import { router } from "../../../../trpc";
import {
  ZCreateOrganizationInput,
  ZDeleteOrganizationInput,
  ZDeleteOrganizationOutput,
  ZGetOrganizationInput,
  ZListOrganizationsInput,
  ZUpdateOrganizationInput,
} from "./organizations.schema";

const organizationsProcedure = authedAdminProcedure.use(organizationsFeatureMiddleware);

const loadService = async () => {
  const { getOrganizationService } = await import(
    "@calcom/features/organizations/di/OrganizationService.container"
  );
  return getOrganizationService();
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
      return service.create(input, ctx.user.id);
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
});
