import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import {
  CurrentOrganizationDtoSchema,
  OrganizationDtoSchema,
  OrganizationMemberDtoSchema,
  OrganizationMemberListDtoSchema,
  OrganizationTeamListDtoSchema,
} from "@calcom/lib/dto/OrganizationDto";
import { OrganizationEmailSenderSettingsDtoSchema } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { OrganizationNotetakerSettingsDtoSchema } from "@calcom/lib/dto/OrganizationNotetakerSettingsDto";
import { OrganizationSmtpSettingsDtoSchema } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
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
  ZTestOrganizationSmtpSettingsInput,
  ZTestOrganizationSmtpSettingsOutput,
  ZUpdateOrganizationEmailSenderInput,
  ZUpdateOrganizationLogoInput,
  ZUpdateOrganizationMemberProfileInput,
  ZUpdateOrganizationMemberRoleInput,
  ZUpdateOrganizationMemberRoleOutput,
  ZUpdateOrganizationNameInput,
  ZUpdateOrganizationNotetakerSettingsInput,
  ZUpdateOrganizationSmtpSettingsInput,
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

const loadEmailSenderService = async () => {
  const { getOrganizationEmailSenderService } = await import(
    "@calcom/features/organizations/di/OrganizationEmailSenderService.container"
  );
  return getOrganizationEmailSenderService();
};

const loadSmtpSettingsService = async () => {
  const { getOrganizationSmtpSettingsService } = await import(
    "@calcom/features/organizations/di/OrganizationSmtpSettingsService.container"
  );
  return getOrganizationSmtpSettingsService();
};

// Saving and testing open outbound SMTP connections, so they are throttled per organization
const checkSmtpRateLimit = (organizationId: number) =>
  checkRateLimitAndThrowError({ rateLimitingType: "core", identifier: `orgSmtp:${organizationId}` });

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
  updateMemberProfile: organizationMemberProcedure
    .input(ZUpdateOrganizationMemberProfileInput)
    .output(OrganizationMemberDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadMembershipService();
      return service.updateMemberProfile({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        userId: input.userId,
        name: input.name,
        username: input.username,
        bio: input.bio,
        avatar: input.avatar,
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
  emailSender: organizationMemberProcedure
    .output(OrganizationEmailSenderSettingsDtoSchema)
    .query(async ({ ctx }) => {
      const service = await loadEmailSenderService();
      return service.get({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
    }),
  updateEmailSender: organizationMemberProcedure
    .input(ZUpdateOrganizationEmailSenderInput)
    .output(OrganizationEmailSenderSettingsDtoSchema)
    .mutation(async ({ ctx, input }) => {
      const service = await loadEmailSenderService();
      await service.update({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        senderName: input.senderName,
        senderAddress: input.senderAddress,
      });
      return service.get({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
    }),
  smtpSettings: organizationMemberProcedure
    .output(OrganizationSmtpSettingsDtoSchema)
    .query(async ({ ctx }) => {
      const service = await loadSmtpSettingsService();
      return service.get({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
    }),
  updateSmtpSettings: organizationMemberProcedure
    .input(ZUpdateOrganizationSmtpSettingsInput)
    .output(OrganizationSmtpSettingsDtoSchema)
    .mutation(async ({ ctx, input }) => {
      await checkSmtpRateLimit(ctx.organizationId);
      const service = await loadSmtpSettingsService();
      await service.update({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        password: input.password,
      });
      return service.get({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
    }),
  removeSmtpSettings: organizationMemberProcedure
    .output(OrganizationSmtpSettingsDtoSchema)
    .mutation(async ({ ctx }) => {
      const service = await loadSmtpSettingsService();
      await service.remove({ organizationId: ctx.organizationId, actorUserId: ctx.user.id });
      return service.get({ organizationId: ctx.organizationId, viewerUserId: ctx.user.id });
    }),
  testSmtpSettings: organizationMemberProcedure
    .input(ZTestOrganizationSmtpSettingsInput)
    .output(ZTestOrganizationSmtpSettingsOutput)
    .mutation(async ({ ctx, input }) => {
      await checkSmtpRateLimit(ctx.organizationId);
      const service = await loadSmtpSettingsService();
      await service.test({
        organizationId: ctx.organizationId,
        actorUserId: ctx.user.id,
        sendTo: input.sendTestEmail ? ctx.user.email : null,
      });
      return { ok: true as const };
    }),
});
