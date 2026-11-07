"use client";

import type { OrganizationMemberDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { ConfirmationDialogContent, Dialog } from "@calcom/ui/components/dialog";
import {
  Dropdown,
  DropdownItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@calcom/ui/components/dropdown";
import { showToast } from "@calcom/ui/components/toast";
import { useState } from "react";

type OrgMemberActionsProps = {
  member: Pick<OrganizationMemberDto, "userId" | "name" | "email" | "role" | "accepted">;
  viewerRole: OrganizationRoleDto;
  viewerUserId: number;
};

export function OrgMemberActions({ member, viewerRole, viewerUserId }: OrgMemberActionsProps) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  const onError = (error: { message: string }) => showToast(t(error.message), "error");

  const updateRole = trpc.viewer.organization.updateRole.useMutation({
    onSuccess: async () => {
      showToast(t("organization_role_updated"), "success");
      await utils.viewer.organization.listMembers.invalidate();
    },
    onError,
  });

  const removeMember = trpc.viewer.organization.removeMember.useMutation({
    onSuccess: async () => {
      showToast(t("organization_member_removed"), "success");
      await utils.viewer.organization.listMembers.invalidate();
    },
    onError,
  });

  // Mirrors the server rules so the menu never offers an action the router would reject.
  const canManage =
    member.userId !== viewerUserId &&
    viewerRole !== "MEMBER" &&
    !(viewerRole === "ADMIN" && member.role === "OWNER");
  if (!canManage) return null;

  const assignableRoles: OrganizationRoleDto[] =
    viewerRole === "OWNER" ? ["OWNER", "ADMIN", "MEMBER"] : ["ADMIN", "MEMBER"];
  const otherRoles = assignableRoles.filter((role) => role !== member.role);

  return (
    <>
      <Dropdown open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="icon"
            color="secondary"
            StartIcon="ellipsis"
            aria-label={t("more")}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>{t("change_role")}</DropdownMenuLabel>
          {otherRoles.map((role) => (
            <DropdownMenuItem key={role} className="outline-none">
              <DropdownItem
                type="button"
                disabled={updateRole.isPending}
                onClick={() => {
                  updateRole.mutate({ userId: member.userId, role });
                  setDropdownOpen(false);
                }}>
                {t(role.toLowerCase())}
              </DropdownItem>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="outline-none">
            <DropdownItem
              type="button"
              color="destructive"
              StartIcon="trash"
              onClick={() => {
                setRemoveDialogOpen(true);
                setDropdownOpen(false);
              }}>
              {t("remove_organization_member")}
            </DropdownItem>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </Dropdown>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <ConfirmationDialogContent
          variety="danger"
          title={t("remove_organization_member")}
          confirmBtnText={t("remove")}
          isPending={removeMember.isPending}
          onConfirm={() => {
            removeMember.mutate({ userId: member.userId });
            setRemoveDialogOpen(false);
          }}>
          {t("remove_organization_member_confirmation", { name: member.name ?? member.email })}
        </ConfirmationDialogContent>
      </Dialog>
    </>
  );
}
