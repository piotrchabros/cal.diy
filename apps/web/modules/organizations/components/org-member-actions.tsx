"use client";

import type { OrganizationMemberDto, OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import {
  ConfirmationDialogContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@calcom/ui/components/dialog";
import {
  Dropdown,
  DropdownItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@calcom/ui/components/dropdown";
import { TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useState } from "react";
import { OrgMemberEditDialog } from "./org-member-edit-dialog";

const USERNAME_TAKEN = "username_taken_in_default_organization";

type OrgMemberActionsProps = {
  member: Pick<
    OrganizationMemberDto,
    "userId" | "name" | "email" | "username" | "bio" | "avatarUrl" | "role"
  >;
  viewerRole: OrganizationRoleDto;
  viewerUserId: number;
};

export function OrgMemberActions({ member, viewerRole, viewerUserId }: OrgMemberActionsProps) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");

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
      setUsernameDialogOpen(false);
      setNewUsername("");
      showToast(t("organization_member_removed"), "success");
      await utils.viewer.organization.listMembers.invalidate();
    },
    onError: (error) => {
      // The member's username is already used in the default organization, so they must pick a new one before leaving.
      if (error.message === USERNAME_TAKEN && !usernameDialogOpen) {
        setRemoveDialogOpen(false);
        setUsernameDialogOpen(true);
        return;
      }
      onError(error);
    },
  });

  const trimmedUsername = newUsername.trim();

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
          <DropdownMenuItem className="outline-none">
            <DropdownItem
              type="button"
              StartIcon="pencil"
              onClick={() => {
                setEditDialogOpen(true);
                setDropdownOpen(false);
              }}>
              {t("edit")}
            </DropdownItem>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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

      {/* Mounted only while open so the form starts from the member's latest data each time */}
      {editDialogOpen && (
        <OrgMemberEditDialog member={member} open={editDialogOpen} onOpenChange={setEditDialogOpen} />
      )}

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

      <Dialog open={usernameDialogOpen} onOpenChange={setUsernameDialogOpen}>
        <DialogContent
          title={t("remove_organization_member")}
          description={t("remove_member_username_taken_description", { name: member.name ?? member.email })}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!trimmedUsername) return;
              removeMember.mutate({ userId: member.userId, newUsername: trimmedUsername });
            }}>
            <TextField
              name="newUsername"
              required
              label={t("new_username")}
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
            />
            <DialogFooter>
              <DialogClose>{t("cancel")}</DialogClose>
              <Button type="submit" disabled={!trimmedUsername} loading={removeMember.isPending}>
                {t("remove")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
