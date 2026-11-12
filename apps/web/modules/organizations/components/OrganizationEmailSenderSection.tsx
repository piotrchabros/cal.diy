"use client";

import { ORGANIZATION_EMAIL_SENDER_NAME_MAX_LENGTH } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useEffect, useState } from "react";

export function OrganizationEmailSenderSection() {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const { data } = trpc.viewer.organization.emailSender.useQuery();
  const [senderName, setSenderName] = useState("");
  const [senderAddress, setSenderAddress] = useState("");

  useEffect(() => {
    if (!data) return;
    setSenderName(data.senderName ?? "");
    setSenderAddress(data.senderAddress ?? "");
  }, [data]);

  const updateEmailSender = trpc.viewer.organization.updateEmailSender.useMutation({
    onSuccess: async () => {
      showToast(t("organization_email_sender_updated"), "success");
      await utils.viewer.organization.emailSender.invalidate();
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  if (!data) return null;

  const { canEdit, allowedDomain, fallbackSenderName, fallbackSenderAddress, senderAddressActive } = data;
  const showInactiveWarning = data.senderAddress !== null && !senderAddressActive;

  return (
    <section
      className="border-subtle mt-8 flex flex-col gap-4 rounded-lg border p-4"
      data-testid="org-email-sender-section">
      <div>
        <h2 className="text-emphasis text-base font-semibold">{t("organization_email_sender")}</h2>
        <p className="text-subtle text-sm">{t("organization_email_sender_description")}</p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEdit) return;
          updateEmailSender.mutate({
            senderName: senderName.trim() || null,
            senderAddress: senderAddress.trim() || null,
          });
        }}>
        <TextField
          name="organizationEmailSenderName"
          label={t("organization_email_sender_name")}
          value={senderName}
          onChange={(event) => setSenderName(event.target.value)}
          maxLength={ORGANIZATION_EMAIL_SENDER_NAME_MAX_LENGTH}
          placeholder={fallbackSenderName}
          disabled={!canEdit}
          data-testid="org-email-sender-name-input"
        />
        <TextField
          name="organizationEmailSenderAddress"
          type="email"
          label={t("organization_email_sender_address")}
          value={senderAddress}
          onChange={(event) => setSenderAddress(event.target.value)}
          placeholder={fallbackSenderAddress ?? ""}
          hint={
            allowedDomain
              ? t("organization_email_sender_domain_hint", { domain: allowedDomain })
              : t("organization_email_sender_no_domain_hint")
          }
          disabled={!canEdit}
          data-testid="org-email-sender-address-input"
        />
        {showInactiveWarning && (
          <p className="text-attention text-sm" data-testid="org-email-sender-inactive">
            {t("organization_email_sender_inactive")}
          </p>
        )}
        {canEdit && (
          <div>
            <Button type="submit" loading={updateEmailSender.isPending} data-testid="org-email-sender-save">
              {t("save")}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}
