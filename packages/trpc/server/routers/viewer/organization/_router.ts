import {
  CurrentOrganizationDtoSchema,
  OrganizationDtoSchema,
  OrganizationMemberListDtoSchema,
  OrganizationTeamListDtoSchema,
} from "@calcom/lib/dto/OrganizationDto";
import { OrganizationNotetakerSettingsDtoSchema } from "@calcom/lib/dto/OrganizationNotetakerSettingsDto";
import { TRPCError } from "@trpc/server";
import { organizationsFeatureMiddleware } from "../../../middlewares/organizationsFeatureMiddleware";
import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import {
  ZInviteOrganizationMemberInput,
  ZInviteOrganizationMemberOutput,
  ZListOrganizationMembersInput,
  ZListOrganizationTeamsInput,
  ZRemoveOrganizationMemberInput,
  ZRemoveOrganizationMemberOutput,
  ZUpdateOrganizationLogoInput,
  ZUpdateOrganizationMemberRoleInput,
  ZUpdateOrganizationMemberRoleOutput,
  ZUpdateOrganizationNameInput,
  ZUpdateOrganizationNotetakerSettingsInput,
} from "./organization.schema";

// The organization always comes from the session, never from input, so a member can only reach their own org
const organizationMemberProcedure = authedProcedure
  .use(organizationsFeatureMiddleware)
  .use(async ({ ctx, next }) => {
    if (!ctx.user.organizationId) throw new TRPCError({ code: "NOT_FOUND" });
    return next({ ctx: { organizationId: ctx.user.organizationId } });
  });

const loadOrganizationService = async () => {
  const { getOrganizationService } = await import(
    "@calcom/features/organizations/di/OrganizationService.container"
  );
  return getOrganizationService();
};

const loadMembershipService = async () => {
  const { getOrganizationMembershipService } = await import(
    "@calcom/features/organizations/di/OrganizationMembershipService.container"
  );
  return getOrganizationMembershipService();
};

const loadNotetakerSettingsService = async () => {
  const { getOrganizationNotetakerSettingsService } = await import(
    "@calcom/features/notetaker/di/OrganizationNotetakerSettingsService.container"
  );
  return getOrganizationNotetakerSettingsService();
};

export const organizationRouter = router({
  current: organizationMemberProcedure.output(CurrentOrganizationDtoSchema).query(async ({ ctx }) => {
    const service = await loadOrganizationService();
    return service.getForMember({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
  }),
  updateName: organizationMemberProcedure
    .input(ZUpdateOrganizationNameInput)
    .output(OrganizationDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadOrganizationService();
      return service.updateName({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        name: input.name,
      });
    }),
  updateLogo: organizationMemberProcedure
    .input(ZUpdateOrganizationLogoInput)
    .output(OrganizationDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadOrganizationService();
      return service.updateLogo({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        logo: input.logo,
      });
    }),
  listMembers: organizationMemberProcedure
    .input(ZListOrganizationMembersInput)
    .output(OrganizationMemberListDtoSchema)
    .query(async ({ ctx, input }) => {
      const service = await loadMembershipService();
      return service.listMembers({ ...input, organizationId: ctx.organizationId, actorUserId: ctx.user.id });
    }),
  inviteMember: organizationMemberProcedure
    .input(ZInviteOrganizationMemberInput)
    .output(ZInviteOrganizationMemberOutput)
    .mutation(async ({ ctx, input }) => {
      const service = await loadMembershipService();
      return service.inviteMember({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name || ctx.user.email,
        email: input.email,
        role: input.role,
      });
    }),
  updateRole: organizationMemberProcedure
    .input(ZUpdateOrganizationMemberRoleInput)
    .output(ZUpdateOrganizationMemberRoleOutput)
    .mutation(async ({ ctx, input }) => {
      const service = await loadMembershipService();
      return service.setRole({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        userId: input.userId,
        role: input.role,
      });
    }),
  removeMember: organizationMemberProcedure
    .input(ZRemoveOrganizationMemberInput)
    .output(ZRemoveOrganizationMemberOutput)
    .mutation(async ({ ctx, input }) => {
      const service = await loadMembershipService();
      return service.removeMember({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        userId: input.userId,
        newUsername: input.newUsername,
      });
    }),
  listTeams: organizationMemberProcedure
    .input(ZListOrganizationTeamsInput)
    .output(OrganizationTeamListDtoSchema)
    .query(async ({ ctx, input }) => {
      const service = await loadMembershipService();
      return service.listTeams({ ...input, organizationId: ctx.organizationId, actorUserId: ctx.user.id });
    }),
  notetakerSettings: organizationMemberProcedure
    .output(OrganizationNotetakerSettingsDtoSchema)
    .query(async ({ ctx }) => {
      const service = await loadNotetakerSettingsService();
      return service.get({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
    }),
  updateNotetakerSettings: organizationMemberProcedure
    .input(ZUpdateOrganizationNotetakerSettingsInput)
    .output(OrganizationNotetakerSettingsDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadNotetakerSettingsService();
      return service.update({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        botName: input.botName,
        botImage: input.botImage,
      });
    }),
});
