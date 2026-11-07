"use client";

import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@calcom/ui/components/dialog";
import { Form, SelectField, TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { Controller, useForm } from "react-hook-form";

type FormValues = { email: string; role: OrganizationRoleDto };

type RoleOption = { value: OrganizationRoleDto; label: string };

export function OrgInviteMemberDialog({
  viewerRole,
  open,
  onOpenChange,
}: {
  viewerRole: OrganizationRoleDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({ defaultValues: { email: "", role: "MEMBER" } });

  const roles: OrganizationRoleDto[] =
    viewerRole === "OWNER" ? ["MEMBER", "ADMIN", "OWNER"] : ["MEMBER", "ADMIN"];
  const roleOptions: RoleOption[] = roles.map((role) => ({ value: role, label: t(role.toLowerCase()) }));

  const inviteMember = trpc.viewer.organization.inviteMember.useMutation({
    onSuccess: async () => {
      showToast(t("organization_member_invited"), "success");
      await utils.viewer.organization.listMembers.invalidate();
      form.reset();
      onOpenChange(false);
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("invite_organization_member")}>
        <Form form={form} handleSubmit={(values) => inviteMember.mutate(values)}>
          <div className="stack-y-4">
            <TextField required type="email" label={t("email")} {...form.register("email")} />
            <Controller
              name="role"
              control={form.control}
              render={({ field }) => (
                <SelectField<RoleOption>
                  label={t("role")}
                  options={roleOptions}
                  value={roleOptions.find((option) => option.value === field.value)}
                  onChange={(option) => option && field.onChange(option.value)}
                />
              )}
            />
          </div>
          <DialogFooter>
            <DialogClose>{t("cancel")}</DialogClose>
            <Button type="submit" loading={inviteMember.isPending}>
              {t("invite")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
