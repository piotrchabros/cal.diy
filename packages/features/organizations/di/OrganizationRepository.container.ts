import { createContainer } from "@calcom/features/di/di";
import {
  moduleLoader as organizationRepositoryModuleLoader,
  type PrismaOrganizationRepository,
} from "./PrismaOrganizationRepository.module";

const organizationRepositoryContainer = createContainer();

export function getOrganizationRepository(): PrismaOrganizationRepository {
  organizationRepositoryModuleLoader.loadModule(organizationRepositoryContainer);

  return organizationRepositoryContainer.get<PrismaOrganizationRepository>(
    organizationRepositoryModuleLoader.token
  );
}
