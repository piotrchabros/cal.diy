"use client";

import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Avatar } from "@calcom/ui/components/avatar";
import type { ReactElement } from "react";

type TeamMembersTabsProps = {
  members: PublicTeamMemberDto[];
  selectedUsername: string | null;
  onSelect: (username: string | null) => void;
};

function tabClassName(isSelected: boolean): string {
  const base =
    "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emphasis";
  return isSelected
    ? `${base} bg-emphasis text-emphasis`
    : `${base} text-subtle hover:bg-subtle hover:text-emphasis`;
}

export function TeamMembersTabs({ members, selectedUsername, onSelect }: TeamMembersTabsProps): ReactElement {
  const { t } = useLocale();
  return (
    <div
      role="tablist"
      aria-label={t("team_members")}
      data-testid="team-members-tabs"
      className="mb-4 flex gap-1 overflow-x-auto pb-1">
      <button
        type="button"
        role="tab"
        aria-selected={selectedUsername === null}
        data-testid="team-tab-whole-team"
        className={tabClassName(selectedUsername === null)}
        onClick={() => onSelect(null)}>
        {t("team_page_whole_team")}
      </button>
      {members.map((member) => {
        const isSelected = member.username === selectedUsername;
        return (
          <button
            key={member.username}
            type="button"
            role="tab"
            aria-selected={isSelected}
            data-testid={`team-tab-${member.username}`}
            className={tabClassName(isSelected)}
            onClick={() => onSelect(member.username)}>
            <Avatar size="sm" alt={member.name} imageSrc={member.avatarUrl || undefined} />
            {member.name}
          </button>
        );
      })}
    </div>
  );
}
