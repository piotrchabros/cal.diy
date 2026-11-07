import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { defaultSendTeamInviteEmail, TeamInviteService } from "../services/TeamInviteService";
import { MEMBERSHIP_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = MEMBERSHIP_DI_TOKENS.TEAM_INVITE_SERVICE;
const moduleToken = MEMBERSHIP_DI_TOKENS.TEAM_INVITE_SERVICE_MODULE;

// sendInviteEmail is a function, not a module, so it cannot go through bindModuleToClassOnToken.
thisModule.bind(token).toFactory(
  () =>
    new TeamInviteService({
      teamRepository: new TeamRepository(),
      sendInviteEmail: defaultSendTeamInviteEmail,
    }),
  "singleton"
);

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;

export type { TeamInviteService };
