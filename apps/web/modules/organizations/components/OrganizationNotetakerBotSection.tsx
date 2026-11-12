"use client";

import { ORGANIZATION_NOTETAKER_BOT_NAME_MAX_LENGTH } from "@calcom/lib/dto/OrganizationNotetakerSettingsDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { TextField } from "@calcom/ui/components/form";
import { BannerUploader } from "@calcom/ui/components/image-uploader";
import { showToast } from "@calcom/ui/components/toast";
import { useEffect, useState } from "react";

const BOT_IMAGE_WIDTH = 1280;
const BOT_IMAGE_HEIGHT = 720;

export function OrganizationNotetakerBotSection() {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const { data } = trpc.viewer.organization.notetakerSettings.useQuery();
  const [botName, setBotName] = useState("");

  useEffect(() => {
    if (data) setBotName(data.botName ?? "");
  }, [data]);

  const updateSettings = trpc.viewer.organization.updateNotetakerSettings.useMutation({
    onSuccess: async () => {
      showToast(t("notetaker_bot_settings_saved"), "success");
      await utils.viewer.organization.notetakerSettings.invalidate();
    },
    onError: (error) => {
      showToast(t(error.message), "error");
    },
  });

  if (!data) return null;

  const { canEdit, botImageDataUrl, fallbackBotName } = data;
  const defaultName = fallbackBotName ?? t("notetaker_bot_name_default_placeholder");

  return (
    <section
      className="border-subtle mt-8 flex flex-col gap-4 rounded-lg border p-4"
      data-testid="org-notetaker-bot-section">
      <div>
        <h2 className="text-emphasis text-base font-semibold">{t("notetaker_bot_settings_title")}</h2>
        <p className="text-subtle text-sm">{t("notetaker_bot_settings_description")}</p>
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEdit) return;
          updateSettings.mutate({ botName: botName.trim() === "" ? null : botName });
        }}>
        <div className="flex-1">
          <TextField
            name="notetakerBotName"
            label={t("notetaker_bot_name_label")}
            value={botName}
            onChange={(event) => setBotName(event.target.value)}
            maxLength={ORGANIZATION_NOTETAKER_BOT_NAME_MAX_LENGTH}
            placeholder={defaultName}
            hint={t("notetaker_bot_name_help", { name: defaultName })}
            disabled={!canEdit}
            data-testid="org-notetaker-bot-name-input"
          />
        </div>
        {canEdit && (
          <Button type="submit" loading={updateSettings.isPending} data-testid="org-notetaker-bot-name-save">
            {t("save")}
          </Button>
        )}
      </form>
      <div className="flex flex-col gap-2">
        <span className="text-default text-sm font-medium">{t("notetaker_bot_image_label")}</span>
        <div className="bg-cal-muted border-subtle flex aspect-video w-full max-w-md items-center justify-center overflow-hidden rounded-md border">
          {botImageDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={botImageDataUrl}
              alt={t("notetaker_bot_image_label")}
              className="h-full w-full object-cover"
              data-testid="org-notetaker-bot-image-preview"
            />
          ) : (
            <p className="text-subtle px-4 text-center text-sm" data-testid="org-notetaker-bot-image-empty">
              {t("notetaker_bot_image_empty")}
            </p>
          )}
        </div>
        <p className="text-subtle text-sm">{t("notetaker_bot_image_help")}</p>
        {canEdit && (
          <div className="flex gap-2">
            <BannerUploader
              id="notetaker-bot-image"
              target={t("notetaker_bot_image_label")}
              buttonMsg={t("notetaker_bot_image_upload")}
              imageSrc={botImageDataUrl ?? undefined}
              aspect={16 / 9}
              width={BOT_IMAGE_WIDTH}
              height={BOT_IMAGE_HEIGHT}
              outputMimeType="image/jpeg"
              handleAvatarChange={(botImage) => updateSettings.mutate({ botImage })}
            />
            {botImageDataUrl && (
              <Button
                type="button"
                color="destructive"
                disabled={updateSettings.isPending}
                onClick={() => updateSettings.mutate({ botImage: null })}
                data-testid="org-notetaker-bot-image-remove">
                {t("notetaker_bot_image_remove")}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
