import { createContainer } from "@calcom/features/di/di";
import {
  type MembershipRepository,
  moduleLoader as membershipRepositoryModuleLoader,
} from "./MembershipRepository.module";

const membershipRepositoryContainer = createContainer();

export function getMembershipRepository(): MembershipRepository {
  membershipRepositoryModuleLoader.loadModule(membershipRepositoryContainer);
  return membershipRepositoryContainer.get<MembershipRepository>(membershipRepositoryModuleLoader.token);
}
