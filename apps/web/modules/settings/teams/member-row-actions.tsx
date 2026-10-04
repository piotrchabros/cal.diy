"use client";

import { useState } from "react";

import { Dialog } from "@calcom/features/components/controlled-dialog";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { MembershipRole } from "@calcom/prisma/enums";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { ConfirmationDialogContent } from "@calcom/ui/components/dialog";
import {
  Dropdown,
  DropdownItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@calcom/ui/components/dropdown";
import { showToast } from "@calcom/ui/components/toast";

import type { MemberItem } from "./members-view";

type ConfirmState =
  | { type: "role"; role: MembershipRole }
  | { type: "remove" }
  | null;

const roleName = (role: MembershipRole, t: (key: string) => string) => {
  if (role === MembershipRole.OWNER) return t("owner");
  if (role === MembershipRole.ADMIN) return t("admin");
  return t("member");
};

export default function MemberRowActions({
  teamId,
  item,
  onChanged,
}: {
  teamId: number;
  item: MemberItem;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const invalidate = () => onChanged();

  const updateRoleMutation = trpc.viewer.teams.updateRole.useMutation({
    onSuccess: () => {
      showToast(t("role_updated"), "success");
      setConfirm(null);
      invalidate();
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  const removeMutation = trpc.viewer.teams.removeMember.useMutation({
    onSuccess: () => {
      showToast(t("member_removed"), "success");
      setConfirm(null);
      invalidate();
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  const resendMutation = trpc.viewer.teams.resendInvite.useMutation({
    onSuccess: () => {
      showToast(t("invite_resent"), "success");
      invalidate();
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  const displayName = item.user.name || item.user.email;
  const isPending = updateRoleMutation.isPending || removeMutation.isPending;

  return (
    <>
      <Dropdown>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="icon" color="minimal" size="sm" StartIcon="ellipsis" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {[MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER]
            .filter((role) => role !== item.role || !item.accepted)
            .map((role) => (
              <DropdownMenuItem key={role}>
                <DropdownItem type="button" onClick={() => setConfirm({ type: "role", role })}>
                  {t("change_role_to", { role: roleName(role, t) })}
                </DropdownItem>
              </DropdownMenuItem>
            ))}
          {!item.accepted && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <DropdownItem
                  type="button"
                  StartIcon="mail"
                  onClick={() => resendMutation.mutate({ teamId, email: item.user.email })}
                  disabled={resendMutation.isPending}>
                  {t("resend_invite")}
                </DropdownItem>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <DropdownItem
              type="button"
              color="destructive"
              StartIcon="trash"
              onClick={() => setConfirm({ type: "remove" })}>
              {t("remove_member")}
            </DropdownItem>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </Dropdown>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        {confirm?.type === "role" && (
          <ConfirmationDialogContent
            title={t("change_role")}
            variety="warning"
            confirmBtnText={t("confirm")}
            cancelBtnText={t("cancel")}
            isPending={updateRoleMutation.isPending}
            onConfirm={() =>
              updateRoleMutation.mutate({ teamId, userId: item.user.id, role: confirm.role })
            }>
            {t("change_role_to_description", {
              name: displayName,
              role: roleName(confirm.role, t),
            })}
          </ConfirmationDialogContent>
        )}
        {confirm?.type === "remove" && (
          <ConfirmationDialogContent
            title={t("remove_member")}
            variety="danger"
            confirmBtnText={t("remove")}
            cancelBtnText={t("cancel")}
            isPending={removeMutation.isPending}
            onConfirm={() => removeMutation.mutate({ teamId, userId: item.user.id })}>
            {t("remove_member_description", { name: displayName })}
          </ConfirmationDialogContent>
        )}
      </Dialog>
      {isPending && <span className="sr-only">{t("loading")}</span>}
    </>
  );
}
