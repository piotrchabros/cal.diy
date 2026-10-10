"use client";

import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";

export function NotetakerSummary({
  summary,
  viewerRole,
  onRegenerate,
  isRegenerating,
}: {
  summary: NotetakerSummaryDto | null;
  viewerRole: NotetakerStateDto["viewerRole"];
  onRegenerate: () => void;
  isRegenerating: boolean;
}): JSX.Element {
  const { t } = useLocale();

  if (summary?.status === "PENDING") {
    return (
      <p className="text-sm text-subtle" data-testid="notetaker-summary-pending">
        {t("notetaker_summary_pending")}
      </p>
    );
  }

  if (summary?.status === "NOT_ENOUGH_CONTENT") {
    return (
      <p className="text-sm text-subtle" data-testid="notetaker-summary-not-enough-content">
        {t("notetaker_summary_not_enough_content")}
      </p>
    );
  }

  if (summary?.status === "READY") {
    return (
      <section data-testid="notetaker-summary" className="flex flex-col gap-3">
        <h3 className="font-medium text-sm">{t("notetaker_summary_overview")}</h3>
        <p className="text-sm">{summary.overview}</p>
        {summary.keyPoints.length > 0 && (
          <>
            <h3 className="font-medium text-sm">{t("notetaker_summary_key_points")}</h3>
            <ul className="list-disc pl-5 text-sm">
              {summary.keyPoints.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </>
        )}
        {summary.decisions.length > 0 && (
          <>
            <h3 className="font-medium text-sm">{t("notetaker_summary_decisions")}</h3>
            <ul className="list-disc pl-5 text-sm">
              {summary.decisions.map((decision) => (
                <li key={decision}>{decision}</li>
              ))}
            </ul>
          </>
        )}
        {summary.actionItems.length > 0 && (
          <>
            <h3 className="font-medium text-sm">{t("notetaker_summary_action_items")}</h3>
            <ul className="list-disc pl-5 text-sm">
              {summary.actionItems.map((item) => (
                <li key={`${item.text}|${item.owner ?? ""}`}>
                  {item.text}
                  {item.owner !== null && (
                    <span className="text-subtle"> {t("notetaker_summary_owner", { name: item.owner })}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-subtle" data-testid="notetaker-summary-failed">
        {t("notetaker_summary_failed")}
      </p>
      {viewerRole === "HOST" && (
        <Button
          color="secondary"
          data-testid="notetaker-summary-regenerate"
          loading={isRegenerating}
          onClick={onRegenerate}>
          {t("notetaker_summary_regenerate")}
        </Button>
      )}
    </div>
  );
}
