"use client";

import type { PublicTeamProfile } from "@calcom/features/teams/services/TeamProfileService";
import type { PublicTeamMemberDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Avatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import EmptyPage from "@calcom/web/modules/event-types/components/EmptyPage";
import { Clock, MapPin } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import { useState } from "react";
import { TeamMembersTabs } from "../components/TeamMembersTabs";
import {
  buildMemberSearch,
  getMemberEventBookingUrl,
  getMemberProfileUrl,
  getTeamEventBookingUrl,
  resolveSelectedMember,
} from "../lib/teamPublicUtils";
import { getTeamInitials } from "../lib/teamsListUtils";

function TeamAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }): ReactElement {
  return (
    <Avatar
      size="lg"
      alt={name}
      imageSrc={logoUrl ?? undefined}
      fallback={
        <span aria-hidden="true" className="text-lg font-semibold">
          {getTeamInitials(name)}
        </span>
      }
    />
  );
}

function TeamSocialLinks({
  socialLinks,
}: {
  socialLinks: PublicTeamProfile["socialLinks"];
}): ReactElement | null {
  if (socialLinks.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {socialLinks.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-subtle hover:text-emphasis text-sm underline-offset-2 hover:underline">
          {link.platform}
        </a>
      ))}
    </div>
  );
}

type EventTypeRowEvent = {
  id: number;
  title: string;
  description: string | null;
  length: number;
};

function EventTypeRow({ href, event }: { href: string; event: EventTypeRowEvent }): ReactElement {
  const { t } = useLocale();
  return (
    <div
      data-testid={`event-type-${event.id}`}
      className="bg-default border-subtle flex items-center justify-between gap-3 border-b p-5 transition last:border-b-0">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="text-default font-medium">{event.title}</span>
          <span className="bg-subtle text-subtle inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs">
            <Clock className="h-3 w-3" aria-hidden />
            {event.length} {t("minute_timeUnit")}
          </span>
        </p>
        {event.description && <p className="text-subtle truncate text-xs">{event.description}</p>}
      </div>
      <Button href={href} color="secondary" data-testid={`book-event-${event.id}`} className="shrink-0">
        {t("book_now")} →
      </Button>
    </div>
  );
}

type TeamPublicViewProps = {
  team: PublicTeamProfile;
  members: PublicTeamMemberDto[];
  initialMemberUsername: string | null;
};

function TeamEventList({ team }: { team: PublicTeamProfile }): ReactElement {
  return (
    <div className="border-subtle rounded-md border" data-testid="event-types">
      {team.eventTypes.map((event) => (
        <EventTypeRow key={event.id} href={getTeamEventBookingUrl(team.slug, event.slug)} event={event} />
      ))}
    </div>
  );
}

function MemberEventList({ member }: { member: PublicTeamMemberDto }): ReactElement {
  const { t } = useLocale();
  return (
    <div data-testid="member-event-types">
      <div className="mb-2 flex justify-end">
        <Link
          href={getMemberProfileUrl(member.username)}
          data-testid="member-profile-link"
          className="text-subtle hover:text-emphasis text-sm underline-offset-2 hover:underline">
          {t("team_page_view_member_profile")}
        </Link>
      </div>
      {member.eventTypes.length > 0 && (
        <div className="border-subtle rounded-md border">
          {member.eventTypes.map((event) => (
            <EventTypeRow
              key={event.id}
              href={getMemberEventBookingUrl(member.username, event.slug)}
              event={event}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TeamPublicView({ team, members, initialMemberUsername }: TeamPublicViewProps): ReactElement {
  const { t } = useLocale();
  const pathname = usePathname();
  const [selectedUsername, setSelectedUsername] = useState<string | null>(
    resolveSelectedMember(members, initialMemberUsername)?.username ?? null
  );
  const hasMembers = members.length > 0;
  const isEventListEmpty = team.eventTypes.length === 0;
  const selectedMember = resolveSelectedMember(members, selectedUsername);

  const handleSelect = (username: string | null): void => {
    setSelectedUsername(username);
    window.history.replaceState(
      null,
      "",
      `${pathname}${buildMemberSearch(window.location.search, username)}`
    );
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <main>
        <div className="border-subtle bg-default text-default mb-8 overflow-hidden rounded-xl border">
          <div className="p-5">
            <TeamAvatar name={team.name} logoUrl={team.logoUrl} />
            <h1 className="font-cal text-emphasis mb-1 mt-4 text-xl" data-testid="team-name">
              {team.name}
            </h1>
            {team.bio && (
              <p className="text-subtle text-sm italic" data-testid="team-bio">
                {team.bio}
              </p>
            )}
            {team.location && (
              <p className="text-subtle mt-2 flex items-center gap-1.5 text-sm" data-testid="team-location">
                <MapPin className="h-4 w-4 shrink-0" aria-hidden />
                {team.location}
              </p>
            )}
            <TeamSocialLinks socialLinks={team.socialLinks} />
          </div>
        </div>

        {hasMembers && (
          <>
            <TeamMembersTabs members={members} selectedUsername={selectedUsername} onSelect={handleSelect} />
            {selectedMember ? (
              <MemberEventList member={selectedMember} />
            ) : isEventListEmpty ? (
              <p className="text-subtle text-sm" data-testid="team-no-event-types">
                {t("team_page_no_team_event_types")}
              </p>
            ) : (
              <TeamEventList team={team} />
            )}
          </>
        )}

        {!hasMembers && !isEventListEmpty && <TeamEventList team={team} />}
        {!hasMembers && isEventListEmpty && <EmptyPage name={team.name} />}
      </main>
    </div>
  );
}
