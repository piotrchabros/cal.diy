"use client";

import type { NotetakerAccessDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";

function colleaguesLine(
  colleagues: NotetakerAccessDto["colleagues"],
  t: ReturnType<typeof useLocale>["t"]
): string | null {
  if (colleagues === null) return null;
  if (colleagues.route === "TEAM")
    return t("notetaker_access_team", {
      teamName: colleagues.teamName,
      interpolation: { escapeValue: false },
    });
  if (colleagues.people.length === 0) return t("notetaker_access_selected_people_none");
  return t("notetaker_access_selected_people", {
    names: colleagues.people.map((person) => person.name).join(", "),
    interpolation: { escapeValue: false },
  });
}

export function NotetakerAccessSummary({ access }: { access: NotetakerAccessDto }): JSX.Element {
  const { t } = useLocale();
  const colleagues = colleaguesLine(access.colleagues, t);

  return (
    <section data-testid="notetaker-access-summary" className="flex flex-col gap-1">
      <h2 className="font-semibold text-emphasis text-sm">{t("notetaker_access_title")}</h2>
      <ul className="list-disc pl-5 text-sm text-subtle">
        <li>{t("notetaker_access_hosts")}</li>
        {access.attendees && <li>{t("notetaker_access_attendees")}</li>}
        {colleagues !== null && <li>{colleagues}</li>}
      </ul>
    </section>
  );
}
