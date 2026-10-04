import { WEBAPP_URL } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { ArrowLeft, ArrowRight, Lock, MoreVertical, RotateCw } from "lucide-react";
import { CREATE_TEAM_PREVIEW_EVENTS } from "./create-team-preview-events";

type TeamPublicPreviewProps = {
  name: string;
  bio: string;
  slug: string;
};

export function TeamPublicPreview({ name, bio, slug }: TeamPublicPreviewProps) {
  const { t } = useLocale();
  const displayName = name.trim() || t("your_name");
  const displayBio = bio.trim() || t("add_your_bio_here");

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-subtle bg-default">
      <div className="flex items-center gap-1.5 border-b border-subtle px-3 py-2">
        <ArrowLeft className="h-3.5 w-3.5 text-subtle" aria-hidden />
        <ArrowRight className="h-3.5 w-3.5 text-subtle" aria-hidden />
        <RotateCw className="h-3.5 w-3.5 text-subtle" aria-hidden />
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-subtle px-3 py-1 text-xs text-subtle">
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">
            {WEBAPP_URL.replace(/^https?:\/\//, "")}/team/{slug.trim()}
          </span>
        </div>
        <MoreVertical className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
      </div>
      <div className="flex flex-1 flex-col bg-subtle px-4 pb-0 pt-4">
        <div className="flex-1 overflow-hidden rounded-xl rounded-b-none border border-b-0 border-subtle bg-default">
          <div className="border-b border-subtle p-5">
            <p className="truncate font-semibold">{displayName}</p>
            <p className="truncate text-sm italic text-subtle">{displayBio}</p>
          </div>
          <ul className="divide-y divide-subtle">
            {CREATE_TEAM_PREVIEW_EVENTS.map((event) => {
              const Icon = event.icon;
              return (
                <li key={event.key} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 text-sm">
                      <span className="font-medium">{t(event.titleKey)}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs text-subtle">
                        <Icon className="h-3 w-3" aria-hidden />
                        {t(event.durationKey)}
                      </span>
                    </p>
                    <p className="truncate text-xs text-subtle">{t(event.descriptionKey)}</p>
                  </div>
                  <Button type="button" color="secondary" size="sm" className="shrink-0" tabIndex={-1}>
                    {t("book_now")} →
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
