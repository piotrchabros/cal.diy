"use client";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import {
  Dropdown,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@calcom/ui/components/dropdown";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";
import { Icon } from "@calcom/ui/components/icon";
import { showToast } from "@calcom/ui/components/toast";
import { ShellMainAppDir } from "app/(use-page-wrapper)/(main-nav)/ShellMainAppDir";
import Link from "next/link";
import type { ReactElement } from "react";
import type { TeamsListTeam } from "~/teams/lib/teamsListUtils";
import { getTeamInitials } from "~/teams/lib/teamsListUtils";

function roleLabel(role: TeamsListTeam["role"], t: (key: string) => string): string {
  if (role === "OWNER") return t("owner");
  if (role === "ADMIN") return t("admin");
  return t("member");
}

function copyTeamLink(publicUrl: string | null, t: (key: string) => string): void {
  if (!publicUrl) return;
  void navigator.clipboard.writeText(publicUrl).then(
    () => showToast(t("link_copied"), "success"),
    () => showToast(t("something_went_wrong"), "error")
  );
}

function TeamAvatar({ team }: { team: TeamsListTeam }): ReactElement {
  if (team.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={team.logoUrl} alt={team.name} className="h-10 w-10 shrink-0 rounded-full object-cover" />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-xs font-semibold text-white dark:bg-white dark:text-black">
      {getTeamInitials(team.name)}
    </span>
  );
}

function TeamCard({ team }: { team: TeamsListTeam }): ReactElement {
  const { t } = useLocale();
  const isOwner = team.role === "OWNER";

  return (
    <div
      data-testid={`team-card-${team.id}`}
      className="border-subtle bg-default flex items-center gap-3 rounded-xl border p-4">
      <TeamAvatar team={team} />
      <div className="min-w-0 flex-1">
        <p className="text-emphasis truncate text-sm font-semibold">{team.name}</p>
        {team.publicUrl ? (
          <Link
            href={team.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-subtle hover:text-emphasis block truncate text-sm">
            {team.publicUrl}
          </Link>
        ) : (
          <p className="text-subtle truncate text-sm">{team.slug ?? team.bio ?? ""}</p>
        )}
      </div>
      <span className={isOwner ? "text-info text-sm font-medium" : "text-subtle text-sm"}>
        {roleLabel(team.role, t)}
      </span>
      <div className="border-subtle flex shrink-0 items-center rounded-lg border">
        <button
          type="button"
          aria-label={t("copy_team_link")}
          title={t("copy_team_link")}
          disabled={!team.publicUrl}
          onClick={() => copyTeamLink(team.publicUrl, t)}
          className="text-default hover:bg-subtle flex h-8 w-8 items-center justify-center rounded-l-lg transition disabled:opacity-40">
          <Icon name="link" className="h-4 w-4" />
        </button>
        <span aria-hidden="true" className="border-subtle h-5 w-px border-l" />
        <Dropdown>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("more_options")}
              className="text-default hover:bg-subtle flex h-8 w-8 items-center justify-center rounded-r-lg transition">
              <Icon name="ellipsis" className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {team.publicUrl && (
              <DropdownMenuItem asChild>
                <Link href={team.publicUrl} target="_blank" rel="noopener noreferrer">
                  <span className="flex items-center gap-2 px-2 py-1.5">
                    <Icon name="external-link" className="h-4 w-4" />
                    {t("preview_team")}
                  </span>
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => copyTeamLink(team.publicUrl, t)} disabled={!team.publicUrl}>
              <span className="flex items-center gap-2 px-2 py-1.5">
                <Icon name="clipboard" className="h-4 w-4" />
                {t("copy_team_link")}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </Dropdown>
      </div>
    </div>
  );
}

export function TeamsListingView({ teams }: { teams: TeamsListTeam[] }): ReactElement {
  const { t } = useLocale();

  return (
    <ShellMainAppDir
      heading={t("teams")}
      subtitle={t("create_manage_teams_collaborative")}
      CTA={
        <Button href="/teams/new" StartIcon="plus" data-testid="new-team-button">
          {t("new")}
        </Button>
      }>
      {teams.length === 0 ? (
        <EmptyScreen
          Icon="users"
          headline={t("no_teams")}
          description={t("no_teams_description")}
          buttonRaw={
            <Button href="/teams/new" StartIcon="plus">
              {t("new_team")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {teams.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </div>
      )}
      <p className="text-subtle mt-6 flex items-center justify-center gap-1.5 text-center text-sm">
        <Icon name="info" className="h-4 w-4 shrink-0" />
        <span>{t("teams_list_tip", { host: WEBAPP_URL.replace(/^https?:\/\//, "") })}</span>
      </p>
    </ShellMainAppDir>
  );
}
