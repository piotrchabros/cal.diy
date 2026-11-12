import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import type { NotetakerCalendarAutoJoinSettingsDto } from "@calcom/lib/dto/NotetakerCalendarAutoJoinDto";
import type { NotetakerEventTypeSharingTeamOptionDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { INotetakerCalendarEventsGatewayResolver } from "../calendar/INotetakerCalendarEventsGateway";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import type { IEventTypeNotetakerSettingsRepository } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type { INotetakerCalendarAutoJoinRepository } from "../repositories/interfaces/INotetakerCalendarAutoJoinRepository";

const NOTETAKER_FEATURE_SLUG = "notetaker";
const CALENDAR_AUTO_JOIN_FEATURE_SLUG = "notetaker-calendar-auto-join";

export interface INotetakerCalendarAutoJoinSettingsServiceDeps {
  autoJoinRepository: Pick<
    INotetakerCalendarAutoJoinRepository,
    "findUserLevelSelectedCalendarsIncludeAutoJoin" | "findUserLevelSelectedCalendar" | "upsert"
  >;
  calendarEventsGatewayResolver: Pick<INotetakerCalendarEventsGatewayResolver, "supportedIntegrations">;
  eventTypeNotetakerSettingsRepository: Pick<
    IEventTypeNotetakerSettingsRepository,
    "findTeamsAndOrganizationsByIds"
  >;
  membershipLookup: Pick<INotetakerMembershipLookup, "listAcceptedTeamIds">;
  featuresRepository: Pick<IFeaturesRepository, "checkIfUserHasFeature">;
}

export class NotetakerCalendarAutoJoinSettingsService {
  constructor(private readonly deps: INotetakerCalendarAutoJoinSettingsServiceDeps) {}

  async list(params: { userId: number }): Promise<NotetakerCalendarAutoJoinSettingsDto> {
    const { userId } = params;
    if (!(await this.isAvailable(userId))) return { available: false, teamOptions: [], calendars: [] };

    const supported = new Set(this.deps.calendarEventsGatewayResolver.supportedIntegrations());
    const [teamOptions, calendars] = await Promise.all([
      this.listTeamOptions(userId),
      this.deps.autoJoinRepository.findUserLevelSelectedCalendarsIncludeAutoJoin({ userId }),
    ]);

    return {
      available: true,
      teamOptions,
      calendars: calendars.map((calendar) => ({
        selectedCalendarId: calendar.id,
        integration: calendar.integration,
        externalId: calendar.externalId,
        enabled: calendar.autoJoin?.enabled ?? false,
        sharingTeamId: calendar.autoJoin?.sharingTeamId ?? null,
        supported: supported.has(calendar.integration),
        lastPollFailed: Boolean(calendar.autoJoin?.lastPollError),
      })),
    };
  }

  async set(params: {
    userId: number;
    selectedCalendarId: string;
    enabled: boolean;
    sharingTeamId: number | null;
  }): Promise<void> {
    const { userId, selectedCalendarId, enabled, sharingTeamId } = params;
    const { autoJoinRepository, calendarEventsGatewayResolver, membershipLookup } = this.deps;

    if (!(await this.isAvailable(userId))) {
      throw ErrorWithCode.Factory.Forbidden("Calendar auto-join is not available for this user");
    }

    const calendar = await autoJoinRepository.findUserLevelSelectedCalendar({ selectedCalendarId, userId });
    if (!calendar) throw ErrorWithCode.Factory.NotFound("Selected calendar not found");

    if (!calendarEventsGatewayResolver.supportedIntegrations().includes(calendar.integration)) {
      throw ErrorWithCode.Factory.BadRequest(
        `Calendar auto-join does not support the ${calendar.integration} integration`
      );
    }

    if (sharingTeamId !== null) {
      const teamIds = await membershipLookup.listAcceptedTeamIds({ userId });
      if (!teamIds.includes(sharingTeamId)) {
        throw ErrorWithCode.Factory.Forbidden("You can only share with a team you are a member of");
      }
    }

    await autoJoinRepository.upsert({ selectedCalendarId, userId, enabled, sharingTeamId });
  }

  private async isAvailable(userId: number): Promise<boolean> {
    const { featuresRepository } = this.deps;
    const [notetaker, calendarAutoJoin] = await Promise.all([
      featuresRepository.checkIfUserHasFeature(userId, NOTETAKER_FEATURE_SLUG),
      featuresRepository.checkIfUserHasFeature(userId, CALENDAR_AUTO_JOIN_FEATURE_SLUG),
    ]);
    return notetaker && calendarAutoJoin;
  }

  private async listTeamOptions(userId: number): Promise<NotetakerEventTypeSharingTeamOptionDto[]> {
    const teamIds = await this.deps.membershipLookup.listAcceptedTeamIds({ userId });
    const teams = await this.deps.eventTypeNotetakerSettingsRepository.findTeamsAndOrganizationsByIds({
      teamIds,
    });
    const organizationsEnabled = isOrganizationsEnabled();
    return teams
      .filter((team) => organizationsEnabled || !team.isOrganization)
      .map(({ teamId, teamName, isOrganization }) => ({ teamId, name: teamName, isOrganization }));
  }
}
