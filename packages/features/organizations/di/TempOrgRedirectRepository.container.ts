import { createContainer } from "@calcom/features/di/di";
import {
  type PrismaTempOrgRedirectRepository,
  moduleLoader as tempOrgRedirectRepositoryModuleLoader,
} from "./PrismaTempOrgRedirectRepository.module";

const tempOrgRedirectRepositoryContainer = createContainer();

export function getTempOrgRedirectRepository(): PrismaTempOrgRedirectRepository {
  tempOrgRedirectRepositoryModuleLoader.loadModule(tempOrgRedirectRepositoryContainer);

  return tempOrgRedirectRepositoryContainer.get<PrismaTempOrgRedirectRepository>(
    tempOrgRedirectRepositoryModuleLoader.token
  );
}
