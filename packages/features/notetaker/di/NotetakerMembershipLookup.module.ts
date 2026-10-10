import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { MembershipRepositoryNotetakerLookup } from "@calcom/features/notetaker/lib/MembershipRepositoryNotetakerLookup";
import { moduleLoader as membershipRepositoryModuleLoader } from "@calcom/features/users/di/MembershipRepository.module";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_MEMBERSHIP_LOOKUP;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_MEMBERSHIP_LOOKUP_MODULE;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: MembershipRepositoryNotetakerLookup,
  dep: membershipRepositoryModuleLoader,
});

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
