"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Avatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import { ImageUploader } from "@calcom/ui/components/image-uploader";
import { showToast } from "@calcom/ui/components/toast";
import { useSession } from "next-auth/react";
import { useState } from "react";

export type OrganizationLogoSectionProps = {
  organizationName: string;
  logoUrl: string | null;
  canEdit: boolean;
};

export function OrganizationLogoSection({
  organizationName,
  logoUrl: initialLogoUrl,
  canEdit,
}: OrganizationLogoSectionProps) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const { update } = useSession();
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl);

  const updateLogo = trpc.viewer.organization.updateLogo.useMutation({
    onSuccess: async (updated) => {
      setLogoUrl(updated.logoUrl);
      showToast(t("organization_logo_updated"), "success");
      await utils.viewer.organization.current.invalidate();
      // The sidebar reads the organization logo from the session token, which only the server can refresh
      await update({ refreshOrganization: true });
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  return (
    <div className="flex items-center" data-testid="org-logo-section">
      <Avatar
        data-testid="org-logo-avatar"
        alt={organizationName}
        imageSrc={logoUrl ?? undefined}
        size="lg"
      />
      {canEdit && (
        <div className="ms-4 flex items-center gap-2">
          <ImageUploader
            target="team"
            id="org-logo-upload"
            buttonMsg={t("upload_logo")}
            handleAvatarChange={(dataUrl) => updateLogo.mutate({ logo: dataUrl })}
            imageSrc={logoUrl ?? ""}
          />
          {logoUrl && (
            <Button
              color="secondary"
              loading={updateLogo.isPending}
              onClick={() => updateLogo.mutate({ logo: null })}
              data-testid="org-logo-remove-button">
              {t("remove_logo")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
