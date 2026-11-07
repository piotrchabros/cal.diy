"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@calcom/ui/components/dialog";
import { Form, TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { OrganizationSelect } from "../../organizations/components/OrganizationSelect";

const USERNAME_TAKEN = "username_taken_in_target_organization";

type FormValues = { toOrganizationId: number | null; newUsername: string };

export function MoveUserToOrganizationDialog({
  userId,
  currentOrganizationId,
  currentUsername,
}: {
  userId: number;
  currentOrganizationId: number | null;
  currentUsername: string | null;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [usernameTaken, setUsernameTaken] = useState(false);
  const form = useForm<FormValues>({
    defaultValues: { toOrganizationId: null, newUsername: currentUsername ?? "" },
  });

  const onOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) return;
    form.reset();
    setUsernameTaken(false);
  };

  const moveUser = trpc.viewer.admin.organizations.moveUser.useMutation({
    onSuccess: async () => {
      showToast(t("user_moved_to_organization"), "success");
      await Promise.all([utils.viewer.users.get.invalidate(), utils.viewer.users.list.invalidate()]);
      onOpenChange(false);
      router.refresh();
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT" && err.message === USERNAME_TAKEN) {
        setUsernameTaken(true);
        return;
      }
      showToast(t(err.message), "error");
    },
  });

  const handleSubmit = ({ toOrganizationId, newUsername }: FormValues) => {
    if (toOrganizationId === null) return;
    moveUser.mutate({
      userId,
      toOrganizationId,
      ...(usernameTaken && { newUsername: newUsername.trim() }),
    });
  };

  const toOrganizationId = form.watch("toOrganizationId");

  return (
    <>
      <Button color="secondary" onClick={() => onOpenChange(true)}>
        {t("move_to_organization")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title={t("move_to_organization")}>
          <Form form={form} handleSubmit={handleSubmit}>
            <div className="stack-y-4">
              <Controller
                name="toOrganizationId"
                control={form.control}
                render={({ field }) => (
                  <OrganizationSelect
                    value={field.value}
                    onChange={(id) => {
                      field.onChange(id);
                      setUsernameTaken(false);
                    }}
                    excludeOrganizationId={currentOrganizationId}
                  />
                )}
              />
              {usernameTaken && (
                <>
                  <p className="text-default text-sm">{t("move_user_username_taken_description")}</p>
                  <TextField required label={t("new_username")} {...form.register("newUsername")} />
                </>
              )}
            </div>
            <DialogFooter>
              <DialogClose>{t("cancel")}</DialogClose>
              <Button type="submit" disabled={toOrganizationId === null} loading={moveUser.isPending}>
                {t("move")}
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
