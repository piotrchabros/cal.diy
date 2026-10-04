import authedProcedure from "../../../procedures/authedProcedure";
import { router } from "../../../trpc";
import { ZTeamAcceptInviteSchema } from "./acceptInvite.schema";
import { ZTeamGetSchema } from "./get.schema";
import { ZTeamInviteMemberSchema } from "./inviteMember.schema";
import { ZTeamListMembersSchema } from "./listMembers.schema";
import { ZTeamRemoveMemberSchema } from "./removeMember.schema";
import { ZTeamResendInviteSchema } from "./resendInvite.schema";
import { ZTeamUpdateRoleSchema } from "./updateRole.schema";

export const teamsRouter = router({
  get: authedProcedure.input(ZTeamGetSchema).query(async ({ ctx, input }) => {
    const handler = (await import("./get.handler")).getHandler;
    return handler({ ctx, input });
  }),
  listMembers: authedProcedure.input(ZTeamListMembersSchema).query(async ({ ctx, input }) => {
    const handler = (await import("./listMembers.handler")).listMembersHandler;
    return handler({ ctx, input });
  }),
  inviteMember: authedProcedure.input(ZTeamInviteMemberSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./inviteMember.handler")).inviteMemberHandler;
    return handler({ ctx, input });
  }),
  acceptInvite: authedProcedure.input(ZTeamAcceptInviteSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./acceptInvite.handler")).acceptInviteHandler;
    return handler({ ctx, input });
  }),
  updateRole: authedProcedure.input(ZTeamUpdateRoleSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./updateRole.handler")).updateRoleHandler;
    return handler({ ctx, input });
  }),
  removeMember: authedProcedure.input(ZTeamRemoveMemberSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./removeMember.handler")).removeMemberHandler;
    return handler({ ctx, input });
  }),
  resendInvite: authedProcedure.input(ZTeamResendInviteSchema).mutation(async ({ ctx, input }) => {
    const handler = (await import("./resendInvite.handler")).resendInviteHandler;
    return handler({ ctx, input });
  }),
});
