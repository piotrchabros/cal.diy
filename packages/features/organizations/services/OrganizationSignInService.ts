import { WEBAPP_URL } from "@calcom/lib/constants";
import logger from "@calcom/lib/logger";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { normalizeHost } from "@calcom/lib/organizations/normalizeHost";
import {
  buildOrganizationLoginUrl,
  buildWrongOrganizationDomainErrorUrl,
} from "@calcom/lib/organizations/organizationSignIn";
import type { IOrganizationMembershipRepository } from "../repositories/interfaces/IOrganizationMembershipRepository";
import type { OrganizationUrlService } from "./OrganizationUrlService";

const log = logger.getSubLogger({ prefix: ["[OrganizationSignInService]"] });

export interface IOrganizationSignInServiceDeps {
  organizationMembershipRepository: IOrganizationMembershipRepository;
  organizationUrlService: OrganizationUrlService;
}

export type SignInDomainDecision =
  | { kind: "allowed" }
  | { kind: "redirect"; loginUrl: string }
  | { kind: "refused"; errorUrl: string };

export class OrganizationSignInService {
  constructor(private readonly deps: IOrganizationSignInServiceDeps) {}

  async checkSignInDomain({
    email,
    requestOrganizationId,
    requestHost,
  }: {
    email: string | null | undefined;
    requestOrganizationId: number | null;
    requestHost: string | null;
  }): Promise<SignInDomainDecision> {
    if (!isOrganizationsEnabled()) return { kind: "allowed" };

    if (!email) {
      log.warn("Refusing sign-in without an email", { requestOrganizationId });
      return { kind: "refused", errorUrl: buildWrongOrganizationDomainErrorUrl(WEBAPP_URL) };
    }

    const user = await this.deps.organizationMembershipRepository.findUserByEmail(email);
    if (!user) return { kind: "allowed" };
    if (user.organizationId === requestOrganizationId) return { kind: "allowed" };

    const baseUrl = await this.deps.organizationUrlService.getBaseUrl({
      organizationId: user.organizationId,
    });

    // The user's organization resolves to the host they are already on (e.g. an org without a
    // custom domain falls back to WEBAPP_URL), so redirecting would send them back here in a loop.
    if (normalizeHost(new URL(baseUrl).host) === normalizeHost(requestHost)) {
      log.warn("Refusing sign-in on a host shared with the user's organization", {
        userId: user.id,
        userOrganizationId: user.organizationId,
        requestOrganizationId,
      });
      return { kind: "refused", errorUrl: buildWrongOrganizationDomainErrorUrl(baseUrl) };
    }

    log.info("Redirecting sign-in to the user's organization", {
      userId: user.id,
      userOrganizationId: user.organizationId,
      requestOrganizationId,
    });
    return { kind: "redirect", loginUrl: buildOrganizationLoginUrl(baseUrl) };
  }
}
