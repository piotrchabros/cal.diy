"use client";

import { useState } from "react";

import { Dialog } from "@calcom/features/components/controlled-dialog";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { MembershipRole } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { DialogContent, DialogFooter, DialogHeader } from "@calcom/ui/components/dialog";
import { Select, TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";

const roleOptions = (t: (key: string) => string) => [
  { value: MembershipRole.MEMBER, label: t("member") },
  { value: MembershipRole.ADMIN, label: t("admin") },
  { value: MembershipRole.OWNER, label: t("owner") },
];

export default function InviteMemberDialog({
  teamId,
  open,
  onOpenChange,
  onInvited,
}: {
  teamId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const { t } = useLocale();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>(MembershipRole.MEMBER);

  const inviteMutation = trpc.viewer.teams.inviteMember.useMutation({
    onSuccess: (data) => {
      showToast(
        data.status === "already-invited" ? t("invite_already_sent") : t("invite_sent"),
        "success"
      );
      setEmail("");
      setRole(MembershipRole.MEMBER);
      onOpenChange(false);
      onInvited();
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  const options = roleOptions(t);
  const canSubmit = email.trim().length > 0 && !inviteMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent type="creation">
        <DialogHeader title={t("invite_member")} subtitle={t("invite_member_description")} />
        <div className="space-y-4">
          <TextField
            label={t("email_address")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("email_example")}
            autoComplete="off"
          />
          <div>
            <label className="mb-1 block text-sm font-medium text-emphasis">{t("role")}</label>
            <Select
              options={options}
              value={options.find((option) => option.value === role)}
              onChange={(option) => {
                if (option) setRole(option.value);
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button color="minimal" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            loading={inviteMutation.isPending}
            disabled={!canSubmit}
            onClick={() => inviteMutation.mutate({ teamId, email: email.trim(), role })}>
            {t("send_invite")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
