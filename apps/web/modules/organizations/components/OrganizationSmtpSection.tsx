"use client";

import type { OrganizationSmtpSecurity } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { ORGANIZATION_SMTP_ALLOWED_PORTS } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { ConfirmationDialogContent, Dialog } from "@calcom/ui/components/dialog";
import { SelectField, TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useEffect, useState } from "react";

const DEFAULT_PORT = 587;
const DEFAULT_SECURITY: OrganizationSmtpSecurity = "STARTTLS";
const SECURITY_MODES: OrganizationSmtpSecurity[] = ["SSL", "STARTTLS", "NONE"];
// Mirrors the server's fallback: without a sender address, a username that is an address is used as From
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PortOption = { value: number; label: string };
type SecurityOption = { value: OrganizationSmtpSecurity; label: string };

export function OrganizationSmtpSection() {
  const { t, i18n } = useLocale();
  const utils = trpc.useUtils();
  const { data, isError } = trpc.viewer.organization.smtpSettings.useQuery();
  const { data: emailSender } = trpc.viewer.organization.emailSender.useQuery();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(DEFAULT_PORT);
  const [security, setSecurity] = useState<OrganizationSmtpSecurity>(DEFAULT_SECURITY);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    setHost(data.host ?? "");
    setPort(data.port ?? DEFAULT_PORT);
    setSecurity(data.security ?? DEFAULT_SECURITY);
    setUsername(data.username ?? "");
    setPassword("");
  }, [data]);

  const refreshSettings = async () => {
    await Promise.all([
      utils.viewer.organization.smtpSettings.invalidate(),
      utils.viewer.organization.emailSender.invalidate(),
    ]);
  };

  const showError = (error: { message: string }) => showToast(t(error.message), "error");

  const updateSmtpSettings = trpc.viewer.organization.updateSmtpSettings.useMutation({
    onSuccess: async () => {
      showToast(t("organization_smtp_saved"), "success");
      await refreshSettings();
    },
    onError: showError,
  });

  const removeSmtpSettings = trpc.viewer.organization.removeSmtpSettings.useMutation({
    onSuccess: async () => {
      showToast(t("organization_smtp_removed"), "success");
      await refreshSettings();
    },
    onError: showError,
  });

  const testSmtpSettings = trpc.viewer.organization.testSmtpSettings.useMutation({
    onSuccess: async () => {
      showToast(t("organization_smtp_test_sent"), "success");
      await utils.viewer.organization.smtpSettings.invalidate();
    },
    onError: showError,
  });

  if (!data || isError) return null;

  const { canEdit, configured, hasPassword, lastVerifiedAt } = data;
  const trimmedUsername = username.trim();
  const isDirty =
    host.trim() !== (data.host ?? "") ||
    port !== (data.port ?? DEFAULT_PORT) ||
    security !== (data.security ?? DEFAULT_SECURITY) ||
    trimmedUsername !== (data.username ?? "") ||
    password !== "";

  const portOptions: PortOption[] = ORGANIZATION_SMTP_ALLOWED_PORTS.map((value) => ({
    value,
    label: String(value),
  }));
  const securityOptions: SecurityOption[] = SECURITY_MODES.map((value) => ({
    value,
    label: t(`organization_smtp_security_${value.toLowerCase()}`),
  }));

  let fromAddress: string | null = null;
  if (emailSender?.usesOrganizationSmtp && emailSender.senderAddress && emailSender.senderAddressActive) {
    fromAddress = emailSender.senderAddress;
  } else if (data.username && EMAIL_LIKE.test(data.username)) {
    fromAddress = data.username;
  }

  return (
    <section
      className="border-subtle mt-8 flex flex-col gap-4 rounded-lg border p-4"
      data-testid="org-smtp-section">
      <div>
        <h2 className="text-emphasis text-base font-semibold">{t("organization_smtp")}</h2>
        <p className="text-subtle text-sm">{t("organization_smtp_description")}</p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEdit) return;
          updateSmtpSettings.mutate({
            host: host.trim(),
            port,
            security,
            username: trimmedUsername || null,
            ...(trimmedUsername && password ? { password } : {}),
          });
        }}>
        <TextField
          name="organizationSmtpHost"
          label={t("organization_smtp_host")}
          value={host}
          onChange={(event) => setHost(event.target.value)}
          maxLength={253}
          placeholder="smtp.example.com"
          required
          disabled={!canEdit}
          data-testid="org-smtp-host-input"
        />
        <div className="flex gap-4">
          <div className="flex-1" data-testid="org-smtp-port-select">
            <SelectField<PortOption>
              label={t("organization_smtp_port")}
              options={portOptions}
              value={portOptions.find((option) => option.value === port)}
              onChange={(option) => option && setPort(option.value)}
              isDisabled={!canEdit}
            />
          </div>
          <div className="flex-1" data-testid="org-smtp-security-select">
            <SelectField<SecurityOption>
              label={t("organization_smtp_security")}
              options={securityOptions}
              value={securityOptions.find((option) => option.value === security)}
              onChange={(option) => option && setSecurity(option.value)}
              isDisabled={!canEdit}
            />
          </div>
        </div>
        {security === "NONE" && (
          <p className="text-attention text-sm" data-testid="org-smtp-security-none-warning">
            {t("organization_smtp_security_none_warning")}
          </p>
        )}
        <TextField
          name="organizationSmtpUsername"
          label={t("organization_smtp_username")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          maxLength={320}
          autoComplete="off"
          hint={t("organization_smtp_optional_auth_hint")}
          disabled={!canEdit}
          data-testid="org-smtp-username-input"
        />
        {canEdit && trimmedUsername !== "" && (
          <TextField
            name="organizationSmtpPassword"
            type="password"
            label={t("organization_smtp_password")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            maxLength={1024}
            autoComplete="new-password"
            placeholder={hasPassword ? t("organization_smtp_password_unchanged") : ""}
            data-testid="org-smtp-password-input"
          />
        )}
        {configured && (
          <div className="text-sm" data-testid="org-smtp-from">
            {fromAddress ? (
              <p className="text-default">
                {t("organization_smtp_from_address")}: <span className="font-medium">{fromAddress}</span>
              </p>
            ) : (
              <p className="text-attention" data-testid="org-smtp-no-sender-warning">
                {t("organization_smtp_no_sender_warning")}
              </p>
            )}
          </div>
        )}
        {lastVerifiedAt && (
          <p className="text-subtle text-sm" data-testid="org-smtp-last-verified">
            {t("organization_smtp_last_verified")}:{" "}
            {new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
              new Date(lastVerifiedAt)
            )}
          </p>
        )}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={updateSmtpSettings.isPending} data-testid="org-smtp-save">
              {t("organization_smtp_save")}
            </Button>
            <Button
              type="button"
              color="secondary"
              loading={testSmtpSettings.isPending}
              disabled={!configured || isDirty}
              onClick={() => testSmtpSettings.mutate({ sendTestEmail: true })}
              data-testid="org-smtp-test">
              {t("organization_smtp_send_test")}
            </Button>
            {configured && (
              <Button
                type="button"
                color="destructive"
                onClick={() => setRemoveDialogOpen(true)}
                data-testid="org-smtp-remove">
                {t("organization_smtp_remove")}
              </Button>
            )}
          </div>
        )}
      </form>
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <ConfirmationDialogContent
          variety="danger"
          title={t("organization_smtp_remove")}
          confirmBtnText={t("organization_smtp_remove")}
          isPending={removeSmtpSettings.isPending}
          onConfirm={() => {
            removeSmtpSettings.mutate();
            setRemoveDialogOpen(false);
          }}>
          {t("organization_smtp_remove_confirm")}
        </ConfirmationDialogContent>
      </Dialog>
    </section>
  );
}
