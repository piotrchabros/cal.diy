"use client";

import type { CurrentOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { OrganizationEmailSenderSection } from "../components/OrganizationEmailSenderSection";
import { OrganizationLogoSection } from "../components/OrganizationLogoSection";
import { OrganizationNotetakerBotSection } from "../components/OrganizationNotetakerBotSection";

const EMPTY_VALUE = "—";

export type OrgGeneralViewProps = {
  organization: CurrentOrganizationDto;
  notetakerEnabled: boolean;
};

export default function OrgGeneralView({ organization, notetakerEnabled }: OrgGeneralViewProps) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const { update } = useSession();
  const canEdit = organization.viewerRole !== "MEMBER";
  const [name, setName] = useState(organization.name);

  const updateName = trpc.viewer.organization.updateName.useMutation({
    onSuccess: async (updated) => {
      setName(updated.name);
      showToast(t("organization_name_updated"), "success");
      await utils.viewer.organization.current.invalidate();
      await update({ refreshOrganization: true });
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <OrganizationLogoSection
        organizationName={organization.name}
        logoUrl={organization.logoUrl}
        canEdit={canEdit}
      />
      {canEdit ? (
        <form
          data-testid="org-general-name-form"
          onSubmit={(event) => {
            event.preventDefault();
            updateName.mutate({ name });
          }}>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextField
                name="organizationName"
                label={t("organization_name")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
                data-testid="org-general-name-input"
              />
            </div>
            <Button
              type="submit"
              loading={updateName.isPending}
              disabled={name.trim() === organization.name.trim()}
              data-testid="org-general-save-button">
              {t("save")}
            </Button>
          </div>
        </form>
      ) : (
        <TextField
          name="organizationName"
          label={t("organization_name")}
          value={organization.name}
          disabled
          data-testid="org-general-name-input"
        />
      )}
      <TextField
        name="organizationSlug"
        label={t("slug")}
        value={organization.slug ?? EMPTY_VALUE}
        disabled
        data-testid="org-general-slug-input"
      />
      <TextField
        name="organizationDomain"
        label={t("domain")}
        value={organization.domain ?? EMPTY_VALUE}
        disabled
        data-testid="org-general-domain-input"
      />
      <p className="text-sm text-subtle" data-testid="org-general-locked-note">
        {t("organization_profile_locked_note")}
      </p>
      <OrganizationEmailSenderSection />
      {notetakerEnabled && <OrganizationNotetakerBotSection />}
    </div>
  );
}
