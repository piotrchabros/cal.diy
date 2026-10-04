"use client";

import {
  TEAM_LOGO_ACCEPTED_TYPES,
  validateTeamLogoFile,
} from "@calcom/features/teams/lib/validateTeamLogoFile";
import { APP_NAME } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import slugify from "@calcom/lib/slugify";
import { trpc } from "@calcom/trpc/react";
import { Avatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import { TextAreaField, TextField } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { TeamLogoSilhouette } from "./team-logo-silhouette";
import { TeamPublicPreview } from "./team-public-preview";
import { useTeamSlugAvailability } from "./use-team-slug-availability";

const URL_SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function CreateTeamView() {
  const { t } = useLocale();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [bio, setBio] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  const normalizedSlug = slugify(slug);
  const isSlugValid = normalizedSlug.length > 0 && URL_SAFE_SLUG_PATTERN.test(normalizedSlug);
  const { isAvailable: isSlugAvailable } = useTeamSlugAvailability(slug);
  const slugFieldErrors = isSlugValid && isSlugAvailable === false ? [t("url_taken")] : undefined;
  const canContinue = name.trim().length > 0 && isSlugValid && isSlugAvailable !== false && !logoError;

  const createTeam = trpc.viewer.teams.create.useMutation({
    onSuccess: (team) => {
      router.push(`/team/${team.slug}`);
    },
    onError: (error) => {
      showToast(error.message, "error");
    },
  });

  const handleNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextName = event.target.value;
    setName(nextName);
    if (!slugTouched) {
      setSlug(slugify(nextName));
    }
  };

  const handleSlugChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSlugTouched(true);
    setSlug(event.target.value);
  };

  const handleLogoSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    const logoError = validateTeamLogoFile(file);
    if (logoError === "invalid-type") {
      setLogoError(t("team_logo_invalid_type"));
      return;
    }
    if (logoError === "too-large") {
      setLogoError(t("team_logo_too_large"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogoDataUrl(typeof reader.result === "string" ? reader.result : null);
      setLogoError(null);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canContinue || createTeam.isPending) {
      return;
    }
    createTeam.mutate({
      name: name.trim(),
      slug: normalizedSlug,
      bio: bio.trim() ? bio.trim() : undefined,
      logoUrl: logoDataUrl,
    });
  };

  return (
    <div className="flex min-h-screen flex-col items-center bg-subtle px-4 py-10">
      <p className="mb-6 text-xl font-bold">{APP_NAME}</p>
      <form
        onSubmit={handleSubmit}
        className="grid w-full max-w-5xl gap-8 rounded-2xl border border-subtle bg-default p-6 md:grid-cols-2 md:p-8">
        <div>
          <h1 className="text-lg font-bold">{t("create_your_team")}</h1>
          <p className="mt-1 text-sm text-subtle">{t("create_team_form_subtitle")}</p>

          <div className="mt-5">
            <p className="text-sm font-semibold">{t("team_logo")}</p>
            <div className="mt-2 flex items-center gap-3">
              <Avatar
                size="lg"
                alt={name.trim() || t("team_logo")}
                imageSrc={logoDataUrl ?? undefined}
                fallback={<TeamLogoSilhouette className="h-10 w-10" />}
              />
              <Button type="button" color="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                {t("upload")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={TEAM_LOGO_ACCEPTED_TYPES.join(",")}
                className="hidden"
                onChange={handleLogoSelect}
                aria-label={t("team_logo")}
              />
            </div>
            <p className="mt-2 text-xs text-subtle">{t("team_logo_size_hint")}</p>
            {logoError && <p className="mt-1 text-xs text-error">{logoError}</p>}
          </div>

          <div className="mt-4">
            <TextField
              name="team_name"
              label={t("team_name")}
              placeholder={t("team_name_placeholder")}
              value={name}
              onChange={handleNameChange}
            />
          </div>

          <div className="mt-4">
            <TextField
              name="team_url"
              label={t("team_url")}
              placeholder={t("team_url_placeholder")}
              value={slug}
              onChange={handleSlugChange}
              addOnLeading={<span className="text-subtle">cal.eu/team/</span>}
              hintErrors={slugFieldErrors}
            />
          </div>

          <div className="mt-4">
            <TextAreaField
              name="team_bio"
              label={t("team_bio")}
              placeholder={t("team_bio_placeholder")}
              rows={4}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" color="minimal" onClick={() => router.back()}>
              {t("cancel")}
            </Button>
            <Button type="submit" color="primary" disabled={!canContinue} loading={createTeam.isPending}>
              {t("continue")}
            </Button>
          </div>
        </div>

        <TeamPublicPreview name={name} bio={bio} slug={normalizedSlug} />
      </form>
    </div>
  );
}
