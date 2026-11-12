"use client";

import { useOrgBaseUrlOr } from "@calcom/features/organizations/lib/OrgBaseUrlContext";
import { FULL_NAME_LENGTH_MAX_LIMIT, WEBSITE_URL } from "@calcom/lib/constants";
import type { OrganizationMemberDto } from "@calcom/lib/dto/OrganizationDto";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { md } from "@calcom/lib/markdownIt";
import slugify from "@calcom/lib/slugify";
import turndown from "@calcom/lib/turndownService";
import type { RouterInputs } from "@calcom/trpc/react";
import { trpc } from "@calcom/trpc/react";
import { Alert } from "@calcom/ui/components/alert";
import { UserAvatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@calcom/ui/components/dialog";
import { Editor } from "@calcom/ui/components/editor";
import { Form, Label, TextField } from "@calcom/ui/components/form";
import { ImageUploader } from "@calcom/ui/components/image-uploader";
import { showToast } from "@calcom/ui/components/toast";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

type EditableMember = Pick<
  OrganizationMemberDto,
  "userId" | "name" | "email" | "username" | "bio" | "avatarUrl"
>;

type FormValues = { name: string; username: string; bio: string; avatar: string | null };

type ProfilePatch = RouterInputs["viewer"]["organization"]["updateMemberProfile"];

const toFormValues = (member: EditableMember): FormValues => ({
  name: member.name ?? "",
  username: member.username ?? "",
  bio: member.bio ?? "",
  avatar: member.avatarUrl,
});

export function OrgMemberEditDialog({
  member,
  open,
  onOpenChange,
}: {
  member: EditableMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const publicBase = useOrgBaseUrlOr(WEBSITE_URL);
  const [firstRender, setFirstRender] = useState(true);
  const form = useForm<FormValues>({ defaultValues: toFormValues(member) });

  const updateMemberProfile = trpc.viewer.organization.updateMemberProfile.useMutation({
    onSuccess: async () => {
      showToast(t("organization_member_profile_updated"), "success");
      await utils.viewer.organization.listMembers.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  const usernameChanged = slugify(form.watch("username")) !== (member.username ?? "");

  const onSubmit = (values: FormValues) => {
    const patch: ProfilePatch = { userId: member.userId };
    const name = values.name.trim();
    const username = slugify(values.username);
    if (name !== (member.name ?? "")) patch.name = name;
    if (username !== (member.username ?? "")) patch.username = username;
    if (values.bio !== (member.bio ?? "")) patch.bio = values.bio;
    if (values.avatar !== member.avatarUrl) patch.avatar = values.avatar;

    if (Object.keys(patch).length === 1) {
      onOpenChange(false);
      return;
    }
    updateMemberProfile.mutate(patch);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("edit_organization_member")}
        description={t("edit_organization_member_description")}>
        <Form form={form} handleSubmit={onSubmit}>
          <div className="stack-y-4">
            <Controller
              control={form.control}
              name="avatar"
              render={({ field: { value, onChange } }) => (
                <div className="flex items-center">
                  <UserAvatar
                    previewSrc={getUserAvatarUrl({ avatarUrl: value })}
                    size="lg"
                    noOrganizationIndicator
                    user={{
                      name: member.name,
                      username: member.username,
                      avatarUrl: value,
                      profile: {
                        id: null,
                        username: member.username,
                        organizationId: null,
                        organization: null,
                      },
                    }}
                  />
                  <div className="ms-4">
                    <h2 className="mb-2 font-medium text-sm">{t("profile_picture")}</h2>
                    <div className="flex gap-2">
                      <ImageUploader
                        target="avatar"
                        id="org-member-avatar-upload"
                        buttonMsg={t("upload_avatar")}
                        handleAvatarChange={(newAvatar) => onChange(newAvatar)}
                        imageSrc={getUserAvatarUrl({ avatarUrl: value })}
                      />
                      {value !== null && (
                        <Button color="minimal" onClick={() => onChange(null)}>
                          {t("remove")}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            />
            <TextField label={t("email")} name="email" value={member.email} readOnly disabled />
            <TextField
              required
              label={t("full_name")}
              {...form.register("name", {
                validate: (value) => value.trim().length > 0 || t("you_need_to_add_a_name"),
                maxLength: {
                  value: FULL_NAME_LENGTH_MAX_LIMIT,
                  message: t("max_limit_allowed_hint", { limit: FULL_NAME_LENGTH_MAX_LIMIT }),
                },
              })}
            />
            <Controller
              control={form.control}
              name="username"
              render={({ field: { value, onChange, onBlur, name } }) => (
                <TextField
                  label={t("username")}
                  name={name}
                  value={value}
                  onBlur={onBlur}
                  addOnLeading={`${publicBase.replace(/^(https?:|)\/\//, "")}/`}
                  onChange={(event) => onChange(slugify(event.target.value, true))}
                />
              )}
            />
            {usernameChanged && <Alert severity="warning" title={t("org_member_username_change_warning")} />}
            <div>
              <Label>{t("about")}</Label>
              <Editor
                getText={() => md.render(form.getValues("bio") || "")}
                setText={(value: string) => {
                  form.setValue("bio", turndown(value), { shouldDirty: true });
                }}
                disableLists
                firstRender={firstRender}
                setFirstRender={setFirstRender}
                height="120px"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose>{t("cancel")}</DialogClose>
            <Button type="submit" loading={updateMemberProfile.isPending}>
              {t("save")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
