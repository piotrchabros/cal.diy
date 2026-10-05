"use client";

import type { PublicTeamProfile } from "@calcom/features/teams/services/TeamProfileService";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Avatar } from "@calcom/ui/components/avatar";
import { Button } from "@calcom/ui/components/button";
import EmptyPage from "@calcom/web/modules/event-types/components/EmptyPage";
import { Clock, MapPin } from "lucide-react";
import type { ReactElement } from "react";
import { getTeamEventBookingUrl } from "~/teams/lib/teamPublicUtils";
import { getTeamInitials } from "~/teams/lib/teamsListUtils";

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

function EventTypeRow({
  teamSlug,
  event,
}: {
  teamSlug: string | null;
  event: PublicTeamProfile["eventTypes"][number];
}): ReactElement {
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
      <Button
        href={getTeamEventBookingUrl(teamSlug, event.slug)}
        color="secondary"
        data-testid={`book-event-${event.id}`}
        className="shrink-0">
        {t("book_now")} →
      </Button>
    </div>
  );
}

export function TeamPublicView({ team }: { team: PublicTeamProfile }): ReactElement {
  const isEventListEmpty = team.eventTypes.length === 0;

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

        {!isEventListEmpty && (
          <div className="border-subtle rounded-md border" data-testid="event-types">
            {team.eventTypes.map((event) => (
              <EventTypeRow key={event.id} teamSlug={team.slug} event={event} />
            ))}
          </div>
        )}

        {isEventListEmpty && <EmptyPage name={team.name} />}
      </main>
    </div>
  );
}
