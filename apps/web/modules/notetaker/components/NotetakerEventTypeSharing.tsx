"use client";

import {
  NOTETAKER_SHARING_MAX_PEOPLE,
  type NotetakerSharingModeDto,
  type NotetakerSharingPersonDto,
} from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { useDebounce } from "@calcom/lib/hooks/useDebounce";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Avatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import { Input } from "@calcom/ui/components/form";
import { useState } from "react";
import {
  useNotetakerEventTypeSharing,
  useNotetakerSharingCandidates,
} from "../hooks/useNotetakerEventTypeSharing";

type Draft = { mode: NotetakerSharingModeDto; people: NotetakerSharingPersonDto[] };

const SEARCH_DEBOUNCE_MS = 300;

const MODES: { mode: NotetakerSharingModeDto; slug: string }[] = [
  { mode: "HOSTS_ONLY", slug: "hosts_only" },
  { mode: "TEAM", slug: "team" },
  { mode: "SELECTED_PEOPLE", slug: "selected_people" },
];

function sortedIds(people: NotetakerSharingPersonDto[]): string {
  return people
    .map((person) => person.userId)
    .sort((a, b) => a - b)
    .join(",");
}

export function NotetakerEventTypeSharing({ eventTypeId }: { eventTypeId: number }): JSX.Element | null {
  const { t, i18n } = useLocale();
  const { query, save } = useNotetakerEventTypeSharing(eventTypeId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);

  const data = query.data;
  const current: Draft | null = data ? (draft ?? { mode: data.mode, people: data.people }) : null;
  const pickerShown = current?.mode === "SELECTED_PEOPLE";
  const candidatesQuery = useNotetakerSharingCandidates({
    eventTypeId,
    search: debouncedSearch,
    enabled: pickerShown,
  });

  if (query.isPending || query.isError || !data || !current) return null;
  if (!data.available) return null;

  const selectedIds = new Set(current.people.map((person) => person.userId));
  const candidates = (candidatesQuery.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((candidate) => !selectedIds.has(candidate.userId));
  const limitReached = current.people.length >= NOTETAKER_SHARING_MAX_PEOPLE;

  const isDirty =
    current.mode !== data.mode ||
    (current.mode === "SELECTED_PEOPLE" && sortedIds(current.people) !== sortedIds(data.people));

  const update = (next: Partial<Draft>) => setDraft({ ...current, ...next });

  const onSave = () => {
    save.mutate(
      {
        eventTypeId,
        mode: current.mode,
        userIds:
          current.mode === "SELECTED_PEOPLE" ? current.people.map((person) => person.userId) : undefined,
      },
      { onSuccess: () => setDraft(null) }
    );
  };

  const formattedSetAt = data.setAt
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(data.setAt))
    : null;

  return (
    <div
      className="rounded-lg border border-subtle px-4 py-6 sm:px-6"
      data-testid="notetaker-event-type-sharing">
      <h3 className="font-semibold text-emphasis text-sm">{t("notetaker_sharing_title")}</h3>
      <p className="mt-1 text-sm text-subtle">{t("notetaker_sharing_description")}</p>

      <div className="mt-4 space-y-3" role="radiogroup" aria-label={t("notetaker_sharing_title")}>
        {MODES.map(({ mode, slug }) => (
          <label key={mode} className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name={`notetaker-sharing-mode-${eventTypeId}`}
              className="mt-1"
              checked={current.mode === mode}
              onChange={() => update({ mode })}
              data-testid={`notetaker-sharing-mode-${slug}`}
            />
            <span>
              <span className="block font-medium text-emphasis text-sm">
                {t(`notetaker_sharing_mode_${slug}`)}
              </span>
              <span className="block text-sm text-subtle">
                {t(`notetaker_sharing_mode_${slug}_description`, { teamName: data.teamName ?? "" })}
              </span>
            </span>
          </label>
        ))}
      </div>

      {pickerShown ? (
        <div className="mt-4" data-testid="notetaker-sharing-people">
          <p className="font-medium text-emphasis text-sm">{t("notetaker_sharing_people_label")}</p>
          {current.people.length === 0 ? (
            <p className="mt-1 text-sm text-subtle">{t("notetaker_sharing_people_empty")}</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {current.people.map((person) => {
                const name = person.name ?? person.email;
                return (
                  <li
                    key={person.userId}
                    className="flex items-center gap-2 rounded-full bg-subtle py-1 pr-2 pl-1"
                    data-testid={`notetaker-sharing-person-${person.userId}`}>
                    <Avatar size="xsm" alt={name} imageSrc={person.avatarUrl} />
                    <span className="text-emphasis text-sm">{name}</span>
                    {!person.stillEligible ? (
                      <span className="text-error text-xs">{t("notetaker_sharing_person_not_eligible")}</span>
                    ) : null}
                    <button
                      type="button"
                      className="text-sm text-subtle hover:text-emphasis"
                      aria-label={t("notetaker_sharing_remove_person", { name })}
                      onClick={() =>
                        update({ people: current.people.filter((p) => p.userId !== person.userId) })
                      }>
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {limitReached ? (
            <p className="mt-2 text-sm text-subtle">
              {t("notetaker_sharing_people_limit", { max: NOTETAKER_SHARING_MAX_PEOPLE })}
            </p>
          ) : null}

          <Input
            className="mt-3"
            type="search"
            value={search}
            placeholder={t("notetaker_sharing_people_search_placeholder")}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="notetaker-sharing-search"
          />
          {candidates.length === 0 && !candidatesQuery.isFetching ? (
            <p className="mt-2 text-sm text-subtle">{t("notetaker_sharing_people_no_candidates")}</p>
          ) : (
            <ul className="mt-2 max-h-60 overflow-y-auto">
              {candidates.map((candidate) => {
                const name = candidate.name ?? candidate.email;
                return (
                  <li key={candidate.userId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-subtle disabled:opacity-50"
                      disabled={limitReached}
                      onClick={() =>
                        update({
                          people: [...current.people, { ...candidate, stillEligible: true }],
                        })
                      }
                      data-testid={`notetaker-sharing-candidate-${candidate.userId}`}>
                      <Avatar size="xsm" alt={name} imageSrc={candidate.avatarUrl} />
                      <span className="text-emphasis text-sm">{name}</span>
                      <span className="text-subtle text-xs">{candidate.email}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {candidatesQuery.hasNextPage ? (
            <Button
              className="mt-2"
              color="minimal"
              size="sm"
              loading={candidatesQuery.isFetchingNextPage}
              onClick={() => candidatesQuery.fetchNextPage()}
              data-testid="notetaker-sharing-load-more">
              {t("load_more_results")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {formattedSetAt ? (
        <p className="mt-4 text-sm text-subtle" data-testid="notetaker-sharing-set-by">
          {data.setByName
            ? t("notetaker_sharing_set_by", { name: data.setByName, date: formattedSetAt })
            : t("notetaker_sharing_set_at", { date: formattedSetAt })}
        </p>
      ) : null}

      <Button
        className="mt-4"
        disabled={!isDirty}
        loading={save.isPending}
        onClick={onSave}
        data-testid="notetaker-sharing-save">
        {t("notetaker_sharing_save")}
      </Button>
    </div>
  );
}
