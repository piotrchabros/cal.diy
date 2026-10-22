"use client";

import type {
  NotetakerSummaryTopicCategoryDto,
  NotetakerSummaryTopicDto,
} from "@calcom/lib/dto/NotetakerSummaryDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Badge } from "@calcom/ui/components/badge";
import { Icon } from "@calcom/ui/components/icon";
import { useEffect, useRef } from "react";

const CATEGORY_BADGES: Record<
  NotetakerSummaryTopicCategoryDto,
  { variant: "red" | "blue" | "green"; labelKey: string }
> = {
  PROBLEM: { variant: "red", labelKey: "notetaker_summary_topic_category_problem" },
  UPDATE: { variant: "blue", labelKey: "notetaker_summary_topic_category_update" },
  DECISION: { variant: "green", labelKey: "notetaker_summary_topic_category_decision" },
};

export function NotetakerSummaryTopics({ topics }: { topics: NotetakerSummaryTopicDto[] }): JSX.Element {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);

  // Collapsed topics would be missing from the printed page, so they are opened for printing and restored afterwards
  useEffect(() => {
    let closedBeforePrint: HTMLDetailsElement[] = [];
    const handleBeforePrint = () => {
      const all = Array.from(containerRef.current?.querySelectorAll("details") ?? []);
      closedBeforePrint = all.filter((details) => !details.open);
      for (const details of closedBeforePrint) details.open = true;
    };
    const handleAfterPrint = () => {
      for (const details of closedBeforePrint) details.open = false;
      closedBeforePrint = [];
    };
    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col gap-1" data-testid="notetaker-summary-topics">
      {topics.map((topic, index) => {
        const badge = topic.category === null ? null : CATEGORY_BADGES[topic.category];
        return (
          <details
            // Titles are model output and can repeat
            key={`${index}|${topic.title}`}
            className="group"
            data-testid="notetaker-summary-topic">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-sm [&::-webkit-details-marker]:hidden">
              <Icon
                name="chevron-right"
                className="h-4 w-4 shrink-0 text-subtle transition-transform group-open:rotate-90"
              />
              <span className="font-medium">{topic.title}</span>
              {badge !== null && (
                <Badge variant={badge.variant} data-testid="notetaker-summary-topic-badge">
                  {t(badge.labelKey)}
                </Badge>
              )}
            </summary>
            {topic.details.length > 0 && (
              <ul className="list-disc py-1 pl-11 text-sm">
                {topic.details.map((detail, detailIndex) => (
                  <li key={`${detailIndex}|${detail}`}>{detail}</li>
                ))}
              </ul>
            )}
          </details>
        );
      })}
    </div>
  );
}
