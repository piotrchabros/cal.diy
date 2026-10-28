"use client";

import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Avatar } from "@calcom/ui/components/avatar";
import type { ReactElement, ReactNode } from "react";
import { getTeamInitials } from "../lib/teamsListUtils";

const tileClassName =
  "bg-default border-subtle hover:border-emphasis focus-visible:ring-emphasis flex aspect-square flex-col items-center justify-center gap-3 rounded-xl border p-3 text-center transition focus:outline-none focus-visible:ring-2";

function Tile({
  testId,
  label,
  avatar,
  onClick,
}: {
  testId: string;
  label: string;
  avatar: ReactNode;
  onClick: () => void;
}): ReactElement {
  return (
    <button type="button" data-testid={testId} className={tileClassName} onClick={onClick}>
      {avatar}
      <span className="text-emphasis w-full truncate text-sm font-medium">{label}</span>
    </button>
  );
}

type TeamMemberTilesProps = {
  teamName: string;
  teamLogoUrl: string | null;
  members: PublicTeamMemberDto[];
  onSelectTeam: () => void;
  onSelectMember: (username: string) => void;
};

export function TeamMemberTiles({
  teamName,
  teamLogoUrl,
  members,
  onSelectTeam,
  onSelectMember,
}: TeamMemberTilesProps): ReactElement {
  const { t } = useLocale();
  return (
    <nav
      aria-label={t("team_members")}
      data-testid="team-member-tiles"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Tile
        testId="team-tile-whole-team"
        label={teamName}
        onClick={onSelectTeam}
        avatar={
          <Avatar
            size="xl"
            alt={teamName}
            imageSrc={teamLogoUrl ?? undefined}
            fallback={
              <span aria-hidden="true" className="text-2xl font-semibold">
                {getTeamInitials(teamName)}
              </span>
            }
          />
        }
      />
      {members.map((member) => (
        <Tile
          key={member.username}
          testId={`team-tile-${member.username}`}
          label={member.name}
          onClick={() => onSelectMember(member.username)}
          avatar={<Avatar size="xl" alt={member.name} imageSrc={member.avatarUrl || undefined} />}
        />
      ))}
    </nav>
  );
}
