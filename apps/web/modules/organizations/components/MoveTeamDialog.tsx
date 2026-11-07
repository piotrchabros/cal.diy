"use client";

import type { MoveTeamPreviewDto } from "@calcom/lib/dto/OrganizationMoveDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Badge } from "@calcom/ui/components/badge";
import { Button } from "@calcom/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@calcom/ui/components/dialog";
import { Form, TextField } from "@calcom/ui/components/form";
import { RadioField, RadioGroup } from "@calcom/ui/components/radio";
import { showToast } from "@calcom/ui/components/toast";
import { Controller, useForm } from "react-hook-form";
import { OrganizationSelect } from "./OrganizationSelect";

type OutsideMembers = "move" | "remove";

type FormValues = {
  toOrganizationId: number | null;
  outsideMembers: OutsideMembers;
  newSlug: string;
  // Keyed `u${userId}` because react-hook-form reads numeric path segments as array indexes
  newUsernames: Record<string, string>;
};

type OutsideMember = MoveTeamPreviewDto["membersOutsideTarget"][number];

export type MoveTeamDialogTeam = { teamId: number; name: string; slug: string | null };

const needsNewUsername = (member: OutsideMember) => member.usernameTaken || member.usernameMissing;

export function MoveTeamDialog({
  team,
  organizationId,
  open,
  onOpenChange,
}: {
  team: MoveTeamDialogTeam;
  organizationId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({
    defaultValues: {
      toOrganizationId: null,
      outsideMembers: "move",
      newSlug: team.slug ?? "",
      newUsernames: {},
    },
  });
  const toOrganizationId = form.watch("toOrganizationId");
  const outsideChoice = form.watch("outsideMembers");

  const preview = trpc.viewer.admin.organizations.previewMoveTeam.useQuery(
    // The placeholder id is never sent: the query stays disabled until an organization is picked
    { teamId: team.teamId, toOrganizationId: toOrganizationId ?? 0 },
    { enabled: toOrganizationId !== null }
  );

  const moveTeam = trpc.viewer.admin.organizations.moveTeam.useMutation({
    onSuccess: async () => {
      showToast(t("team_moved_to_organization"), "success");
      await Promise.all([
        utils.viewer.admin.organizations.listTeams.invalidate(),
        utils.viewer.admin.organizations.get.invalidate(),
        utils.viewer.admin.organizations.list.invalidate(),
      ]);
      onOpenChange(false);
    },
    onError: (err) => {
      showToast(t(err.message), "error");
    },
  });

  const outsideMembers = toOrganizationId !== null ? (preview.data?.membersOutsideTarget ?? []) : [];
  const slugTaken = toOrganizationId !== null && preview.data?.slugTaken === true;
  const askForNewUsernames = outsideChoice === "move" && outsideMembers.some(needsNewUsername);

  const handleSubmit = (values: FormValues) => {
    if (values.toOrganizationId === null || !preview.data) return;
    const newUsernames =
      values.outsideMembers === "move"
        ? outsideMembers.filter(needsNewUsername).map((member) => ({
            userId: member.userId,
            username: values.newUsernames[`u${member.userId}`]?.trim() ?? "",
          }))
        : [];
    moveTeam.mutate({
      teamId: team.teamId,
      toOrganizationId: values.toOrganizationId,
      outsideMembers: values.outsideMembers,
      ...(slugTaken && { newSlug: values.newSlug.trim() }),
      ...(newUsernames.length > 0 && { newUsernames }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("move_team_to_organization", { name: team.name })}>
        <Form form={form} handleSubmit={handleSubmit}>
          <div className="stack-y-4">
            <Controller
              name="toOrganizationId"
              control={form.control}
              render={({ field }) => (
                <OrganizationSelect
                  value={field.value}
                  onChange={field.onChange}
                  excludeOrganizationId={organizationId}
                />
              )}
            />
            {outsideMembers.length > 0 && (
              <div className="stack-y-2">
                <p className="text-default text-sm">{t("move_team_outside_members_description")}</p>
                {askForNewUsernames && outsideMembers.some((member) => member.usernameTaken) && (
                  <p className="text-default text-sm">{t("move_team_member_usernames_taken_description")}</p>
                )}
                {askForNewUsernames && outsideMembers.some((member) => member.usernameMissing) && (
                  <p className="text-default text-sm">
                    {t("move_team_member_usernames_missing_description")}
                  </p>
                )}
                <ul className="text-default stack-y-2 text-sm" data-testid="move-team-outside-members">
                  {outsideMembers.map((member) => (
                    <li key={member.userId} className="flex flex-wrap items-center gap-2">
                      <span>{member.name ? `${member.name} (${member.email})` : member.email}</span>
                      {member.usernameTaken && <Badge variant="orange">{t("username_taken_badge")}</Badge>}
                      {member.usernameMissing && (
                        <Badge variant="orange">{t("username_missing_badge")}</Badge>
                      )}
                      {needsNewUsername(member) && outsideChoice === "move" && (
                        <div className="w-full">
                          <TextField
                            required
                            label={t("move_team_member_new_username", { name: member.name ?? member.email })}
                            {...form.register(`newUsernames.u${member.userId}`)}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <Controller
                  name="outsideMembers"
                  control={form.control}
                  render={({ field }) => (
                    <RadioGroup
                      value={field.value}
                      onValueChange={(value) => field.onChange(value === "remove" ? "remove" : "move")}>
                      <RadioField
                        id="outside-members-move"
                        value="move"
                        label={t("move_team_outside_members_move")}
                      />
                      <RadioField
                        id="outside-members-remove"
                        value="remove"
                        label={t("move_team_outside_members_remove")}
                      />
                    </RadioGroup>
                  )}
                />
              </div>
            )}
            {slugTaken && (
              <>
                <p className="text-default text-sm">{t("move_team_slug_taken_description")}</p>
                <TextField required label={t("new_team_slug")} {...form.register("newSlug")} />
              </>
            )}
          </div>
          <DialogFooter>
            <DialogClose>{t("cancel")}</DialogClose>
            <Button
              type="submit"
              disabled={!preview.data || toOrganizationId === null}
              loading={moveTeam.isPending}>
              {t("move")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
