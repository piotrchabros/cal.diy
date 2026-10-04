"use client";

import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import SectionBottomActions from "@calcom/features/settings/SectionBottomActions";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { useCopy } from "@calcom/lib/hooks/useCopy";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { md } from "@calcom/lib/markdownIt";
import turndown from "@calcom/lib/turndownService";
import type { RouterOutputs } from "@calcom/trpc/react";
import { trpc } from "@calcom/trpc/react";
import { Avatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import { Editor } from "@calcom/ui/components/editor";
import { Form, Label, TextField } from "@calcom/ui/components/form";
import { CheckboxField } from "@calcom/ui/components/form/checkbox";
import { ImageUploader } from "@calcom/ui/components/image-uploader";
import { showToast } from "@calcom/ui/components/toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { revalidateSettingsTeamProfile } from "app/cache/path/settings/my-teams";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import TeamDangerZone from "./team-danger-zone";

type TeamProfile = RouterOutputs["viewer"]["teams"]["getProfile"];

const socialLinkSchema = z.object({
  platform: z.string().trim().min(1).max(50),
  url: z.string().trim().url().max(2048),
});

const formSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  bio: z.string().max(2000).optional(),
  logoUrl: z.string().url().max(2048).nullable().optional(),
  location: z.string().trim().max(255).optional(),
  showMap: z.boolean().optional(),
  socialLinks: z.array(socialLinkSchema).max(10).optional(),
});

type FormValues = z.infer<typeof formSchema>;

const teamUrlHost = WEBAPP_URL.replace(/^https?:\/\//, "");

const TeamProfileView = ({ team }: { team: TeamProfile }) => {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const { copyToClipboard } = useCopy();
  const [firstRender, setFirstRender] = useState(true);

  const updateProfileMutation = trpc.viewer.teams.updateProfile.useMutation({
    onSuccess: async () => {
      await utils.viewer.teams.getProfile.invalidate({ teamId: team.id });
      await revalidateSettingsTeamProfile(team.id);
      showToast(t("settings_updated_successfully"), "success");
    },
    onError: (e) => {
      if (e.message.includes("already taken")) {
        showToast(t("url_taken"), "error");
        return;
      }
      showToast(t("error_updating_settings"), "error");
    },
  });

  const formMethods = useForm<FormValues>({
    defaultValues: {
      name: team.name,
      slug: team.slug ?? "",
      bio: team.bio ?? "",
      logoUrl: team.logoUrl,
      location: team.location ?? "",
      showMap: team.showMap,
      socialLinks: team.socialLinks,
    },
    resolver: zodResolver(formSchema),
  });

  const {
    formState: { isSubmitting, isDirty },
  } = formMethods;

  const { fields, append, remove } = useFieldArray({
    control: formMethods.control,
    name: "socialLinks",
  });

  const logoUrl = formMethods.watch("logoUrl");
  const isDisabled = isSubmitting || !isDirty || updateProfileMutation.isPending;

  const handleSubmit = (values: FormValues) => {
    updateProfileMutation.mutate({
      teamId: team.id,
      name: values.name,
      slug: values.slug,
      bio: values.bio || undefined,
      logoUrl: values.logoUrl,
      location: values.location || undefined,
      showMap: values.showMap,
      socialLinks: values.socialLinks,
    });
  };

  return (
    <SettingsHeader
      title={t("team_profile")}
      description={t("manage_settings_for_your_team_profile")}
      borderInShellHeader={true}>
      <Form form={formMethods} handleSubmit={handleSubmit}>
        <div className="rounded-b-lg border border-subtle border-t-0 px-4 pb-10 pt-8 sm:px-6">
          <div className="flex items-center">
            <Avatar
              data-testid="team-profile-avatar"
              alt={team.name}
              imageSrc={logoUrl ?? team.logoUrl ?? undefined}
              size="lg"
            />
            <div className="ms-4">
              <ImageUploader
                target="team"
                id="team-logo-upload"
                buttonMsg={t("upload_logo")}
                handleAvatarChange={(newLogo) => {
                  formMethods.setValue("logoUrl", newLogo, { shouldDirty: true });
                }}
                imageSrc={logoUrl ?? team.logoUrl ?? ""}
              />
            </div>
          </div>

          <div className="mt-6">
            <TextField label={t("team_name")} {...formMethods.register("name")} />
          </div>

          <div className="mt-6">
            <TextField
              label={t("team_url")}
              addOnLeading={`${teamUrlHost}/team/`}
              {...formMethods.register("slug")}
            />
          </div>

          <div className="mt-6">
            <Label>{t("team_id")}</Label>
            <div className="flex items-center gap-2">
              <TextField
                value={String(team.id)}
                disabled
                readOnly
                className="flex-1"
                containerClassName="flex-1"
              />
              <Button
                color="secondary"
                variant="icon"
                StartIcon="copy"
                aria-label={t("copy")}
                onClick={() =>
                  copyToClipboard(String(team.id), {
                    onSuccess: () => showToast(t("copied"), "success"),
                  })
                }
              />
            </div>
          </div>

          <div className="mt-6">
            <Label>{t("about")}</Label>
            <Editor
              getText={() => md.render(formMethods.getValues("bio") || "")}
              setText={(value: string) => {
                formMethods.setValue("bio", turndown(value), { shouldDirty: true });
              }}
              disableLists
              firstRender={firstRender}
              setFirstRender={setFirstRender}
              height="120px"
            />
            <p className="mt-2 text-sm text-subtle">{t("team_description")}</p>
          </div>

          <div className="mt-6">
            <TextField label={t("location")} {...formMethods.register("location")} />
            <div className="mt-3">
              <CheckboxField
                name="showMap"
                label={t("show_map_of_this_location")}
                description={t("show_map_hint")}
              />
            </div>
          </div>

          <div className="mt-6">
            <Label>{t("social_links")}</Label>
            <div className="stack-y-3 flex flex-col">
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-start gap-2">
                  <TextField
                    placeholder={t("social_platform")}
                    {...formMethods.register(`socialLinks.${index}.platform`)}
                    containerClassName="w-1/3"
                  />
                  <TextField
                    placeholder={t("social_url")}
                    {...formMethods.register(`socialLinks.${index}.url`)}
                    containerClassName="flex-1"
                  />
                  <Button
                    color="minimal"
                    variant="icon"
                    StartIcon="trash-2"
                    aria-label={t("remove")}
                    onClick={() => remove(index)}
                  />
                </div>
              ))}
            </div>
            <Button
              color="secondary"
              StartIcon="plus"
              className="mt-2"
              onClick={() => append({ platform: "", url: "" })}>
              {t("add_social_link")}
            </Button>
          </div>
        </div>
        <SectionBottomActions align="end">
          <Button type="submit" disabled={isDisabled} data-testid="team-profile-update">
            {t("update")}
          </Button>
        </SectionBottomActions>
      </Form>
      <TeamDangerZone teamId={team.id} role={team.role} />
    </SettingsHeader>
  );
};

export default TeamProfileView;
