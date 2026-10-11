import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import type {
  NotetakerEventTypeSharingDto,
  NotetakerSharingCandidatesDto,
  NotetakerSharingModeDto,
  NotetakerSharingPersonDto,
  NotetakerSharingTeamOptionDto,
  NotetakerSharingUnavailableReasonDto,
} from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { NOTETAKER_SHARING_MAX_PEOPLE } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type {
  IEventTypeNotetakerSettingsRepository,
  NotetakerEventTypeContext,
} from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";

const NOTETAKER_FEATURE_SLUG = "notetaker";
const DEFAULT_CANDIDATE_LIMIT = 20;
const MAX_CANDIDATE_LIMIT = 50;

type SharingTarget =
  | { kind: "TEAM_EVENT_TYPE"; teamId: number; teamName: string | null; eligibilityTeamId: number }
  | {
      kind: "PERSONAL";
      ownerUserId: number;
      teamOptions: NotetakerSharingTeamOptionDto[];
      chosenTeam: NotetakerSharingTeamOptionDto | null;
    }
  | { kind: "NONE" };

type SharingWrite = {
  /** Where the selected people must be accepted members; null when no team is in force. */
  eligibilityTeamId: number | null;
  teamChanged: boolean;
  sharingTeamId: number | null;
  previousTeamName: string | null;
  newTeamName: string | null;
};

export interface INotetakerSharingSettingsServiceDeps {
  eventTypeNotetakerSettingsRepository: IEventTypeNotetakerSettingsRepository;
  membershipLookup: INotetakerMembershipLookup;
  featuresRepository: Pick<IFeaturesRepository, "checkIfUserHasFeature">;
  userRepository: INotetakerUserLookup;
  config: NotetakerConfig;
}

export class NotetakerSharingSettingsService {
  constructor(private readonly deps: INotetakerSharingSettingsServiceDeps) {}

  async get(params: { eventTypeId: number; userId: number }): Promise<NotetakerEventTypeSharingDto> {
    const { eventTypeId, userId } = params;
    const context = await this.getEventTypeOrThrow(eventTypeId);
    const featureEnabled = await this.isFeatureEnabled(userId);
    const target = await this.resolveTarget(context, userId);
    return this.buildDto(context, featureEnabled, target);
  }

  async set(params: {
    eventTypeId: number;
    mode: NotetakerSharingModeDto;
    userIds?: number[];
    teamId?: number;
    userId: number;
  }): Promise<NotetakerEventTypeSharingDto> {
    const { eventTypeId, mode, userId } = params;
    const { eventTypeNotetakerSettingsRepository, membershipLookup, userRepository } = this.deps;

    const context = await this.getEventTypeOrThrow(eventTypeId);
    if (!(await this.isFeatureEnabled(userId))) {
      throw ErrorWithCode.Factory.Forbidden("FEATURE_DISABLED");
    }

    const target = await this.resolveTarget(context, userId);
    const asksForSharing = mode !== "HOSTS_ONLY" || (params.userIds?.length ?? 0) > 0;

    if (target.kind === "NONE") {
      if (asksForSharing) throw ErrorWithCode.Factory.BadRequest("NOT_A_TEAM_EVENT_TYPE");
      return this.buildDto(context, true, target);
    }
    if (target.kind === "PERSONAL" && target.teamOptions.length === 0) {
      if (asksForSharing) throw ErrorWithCode.Factory.BadRequest("NO_TEAM_TO_SHARE_WITH");
      return this.buildDto(context, true, target);
    }

    const write =
      target.kind === "TEAM_EVENT_TYPE"
        ? await this.resolveTeamEventTypeWrite(context, target, params)
        : this.resolvePersonalWrite(context, target, params);

    // Compared with what is stored, not with what is in force, so the owner can always save
    // "hosts only" explicitly after leaving the team.
    const previousMode = context.settings?.sharingMode ?? "HOSTS_ONLY";

    // A list names members of one team, so a change of team replaces it and never carries it over.
    let wantedUserIds: number[] | undefined;
    if (write.teamChanged) {
      wantedUserIds = mode === "SELECTED_PEOPLE" ? (params.userIds ?? []) : [];
    } else if (mode === "SELECTED_PEOPLE" && params.userIds !== undefined) {
      wantedUserIds = params.userIds;
    }

    let memberUserIds: number[] | undefined;
    let addedUserNames: string[] = [];
    let removedUserNames: string[] = [];

    if (wantedUserIds !== undefined) {
      memberUserIds = Array.from(new Set(wantedUserIds));
      if (memberUserIds.length > NOTETAKER_SHARING_MAX_PEOPLE) {
        throw ErrorWithCode.Factory.BadRequest("TOO_MANY_PEOPLE");
      }

      if (memberUserIds.length > 0) {
        const eligibleIds = new Set(
          write.eligibilityTeamId === null
            ? []
            : await membershipLookup.findAcceptedUserIds({
                teamId: write.eligibilityTeamId,
                userIds: memberUserIds,
              })
        );
        // The message carries neither id nor name, so a probe cannot learn who exists.
        if (memberUserIds.some((id) => !eligibleIds.has(id))) {
          throw ErrorWithCode.Factory.BadRequest("PERSON_NOT_ELIGIBLE");
        }
      }

      const currentMembers =
        await eventTypeNotetakerSettingsRepository.findSharingMembersIncludeUser(eventTypeId);
      const currentIds = new Set(currentMembers.map((member) => member.userId));
      const wantedIds = new Set(memberUserIds);

      removedUserNames = currentMembers
        .filter((member) => !wantedIds.has(member.userId))
        .map((member) => member.name ?? member.email);

      const addedIds = memberUserIds.filter((id) => !currentIds.has(id));
      if (addedIds.length > 0) {
        const addedUsers = await userRepository.findByIds({ ids: addedIds });
        const namesById = new Map(addedUsers.map((user) => [user.id, user.name ?? user.email]));
        addedUserNames = addedIds.flatMap((id) => {
          const name = namesById.get(id);
          return name === undefined ? [] : [name];
        });
      }
    }

    const nothingChanged =
      mode === previousMode &&
      !write.teamChanged &&
      addedUserNames.length === 0 &&
      removedUserNames.length === 0;
    if (nothingChanged) return this.buildDto(context, true, target);

    const [actor] = await userRepository.findByIds({ ids: [userId] });
    await eventTypeNotetakerSettingsRepository.updateSharing({
      eventTypeId,
      sharingMode: mode,
      sharingSetByUserId: userId,
      sharingSetAt: new Date(),
      memberUserIds,
      sharingTeamId: write.sharingTeamId,
      change: {
        actorUserId: userId,
        actorName: actor ? (actor.name ?? actor.email) : null,
        previousMode,
        newMode: mode,
        addedUserNames,
        removedUserNames,
        previousTeamName: write.previousTeamName,
        newTeamName: write.newTeamName,
      },
    });

    return this.get({ eventTypeId, userId });
  }

  async listCandidates(params: {
    eventTypeId: number;
    teamId?: number;
    search?: string;
    cursor?: number | null;
    limit?: number;
    userId: number;
  }): Promise<NotetakerSharingCandidatesDto> {
    const { eventTypeId, userId } = params;

    const context = await this.getEventTypeOrThrow(eventTypeId);
    if (!(await this.isFeatureEnabled(userId))) {
      throw ErrorWithCode.Factory.Forbidden("FEATURE_DISABLED");
    }

    const target = await this.resolveTarget(context, userId);
    if (target.kind === "NONE") {
      throw ErrorWithCode.Factory.BadRequest("NOT_A_TEAM_EVENT_TYPE");
    }

    let candidateTeamId: number;
    if (target.kind === "TEAM_EVENT_TYPE") {
      await this.assertActorIsMember(userId, target.eligibilityTeamId);
      this.assertOwningTeam(target.teamId, params.teamId);
      candidateTeamId = target.eligibilityTeamId;
    } else {
      const team = this.resolvePersonalTeam(target, params.teamId);
      if (team === null) throw ErrorWithCode.Factory.BadRequest("TEAM_REQUIRED");
      candidateTeamId = team.teamId;
    }

    const limit = Math.min(MAX_CANDIDATE_LIMIT, Math.max(1, params.limit ?? DEFAULT_CANDIDATE_LIMIT));
    const search = params.search?.trim() || null;
    const page = await this.deps.membershipLookup.searchAcceptedMembers({
      teamId: candidateTeamId,
      search,
      cursor: params.cursor ?? null,
      limit,
    });

    return {
      items: page.items.map(({ userId: candidateId, name, email, avatarUrl }) => ({
        userId: candidateId,
        name,
        email,
        avatarUrl,
      })),
      nextCursor: page.nextCursor,
    };
  }

  private async getEventTypeOrThrow(eventTypeId: number): Promise<NotetakerEventTypeContext> {
    const context =
      await this.deps.eventTypeNotetakerSettingsRepository.findByEventTypeIdIncludeEventType(eventTypeId);
    if (!context) throw ErrorWithCode.Factory.NotFound("EVENT_TYPE_NOT_FOUND");
    return context;
  }

  private async isFeatureEnabled(userId: number): Promise<boolean> {
    const hasFeature = await this.deps.featuresRepository.checkIfUserHasFeature(
      userId,
      NOTETAKER_FEATURE_SLUG
    );
    return hasFeature && isNotetakerBotProviderUsable(this.deps.config);
  }

  private async resolveTarget(
    context: NotetakerEventTypeContext,
    actorUserId: number
  ): Promise<SharingTarget> {
    if (context.teamId !== null) {
      return {
        kind: "TEAM_EVENT_TYPE",
        teamId: context.teamId,
        teamName: context.teamName,
        // Colleagues are drawn from the organization when there is one, so a team can share with
        // anyone in the organization it belongs to.
        eligibilityTeamId: context.organizationId ?? context.teamId,
      };
    }
    if (context.userId === null) return { kind: "NONE" };

    // eventOwnerProcedure also lets through every user assigned to a personal event type; only
    // its owner may read or decide who the results are shared with.
    if (actorUserId !== context.userId) throw ErrorWithCode.Factory.Forbidden("NOT_ALLOWED");

    const { eventTypeNotetakerSettingsRepository, membershipLookup } = this.deps;
    const ownerTeamIds = await membershipLookup.listAcceptedTeamIds({ userId: context.userId });
    const teams = await eventTypeNotetakerSettingsRepository.findTeamsByIds({ teamIds: ownerTeamIds });
    const teamOptions = teams.map(({ teamId, teamName }) => ({ teamId, name: teamName }));
    const storedTeamId = context.settings?.sharingTeamId ?? null;

    return {
      kind: "PERSONAL",
      ownerUserId: context.userId,
      teamOptions,
      chosenTeam: teamOptions.find((option) => option.teamId === storedTeamId) ?? null,
    };
  }

  private async resolveTeamEventTypeWrite(
    context: NotetakerEventTypeContext,
    target: Extract<SharingTarget, { kind: "TEAM_EVENT_TYPE" }>,
    params: { teamId?: number; userId: number }
  ): Promise<SharingWrite> {
    await this.assertActorIsMember(params.userId, target.eligibilityTeamId);
    this.assertOwningTeam(target.teamId, params.teamId);
    return {
      eligibilityTeamId: target.eligibilityTeamId,
      teamChanged: false,
      // The owning team wins; clearing the column keeps a stale choice from coming back if the
      // event type becomes personal again.
      sharingTeamId: null,
      previousTeamName: context.teamName,
      newTeamName: context.teamName,
    };
  }

  private resolvePersonalWrite(
    context: NotetakerEventTypeContext,
    target: Extract<SharingTarget, { kind: "PERSONAL" }>,
    params: { mode: NotetakerSharingModeDto; teamId?: number }
  ): SharingWrite {
    const team = this.resolvePersonalTeam(target, params.teamId);
    if (params.mode !== "HOSTS_ONLY" && team === null) {
      throw ErrorWithCode.Factory.BadRequest("TEAM_REQUIRED");
    }
    const teamId = team?.teamId ?? null;
    return {
      eligibilityTeamId: teamId,
      teamChanged: teamId !== (context.settings?.sharingTeamId ?? null),
      sharingTeamId: teamId,
      previousTeamName: context.effectiveSharingTeamName,
      newTeamName: team?.name ?? null,
    };
  }

  // The message names no team, so a probe cannot learn which teams exist.
  private resolvePersonalTeam(
    target: Extract<SharingTarget, { kind: "PERSONAL" }>,
    requestedTeamId: number | undefined
  ): NotetakerSharingTeamOptionDto | null {
    if (requestedTeamId === undefined) return target.chosenTeam;
    const requested = target.teamOptions.find((option) => option.teamId === requestedTeamId);
    if (!requested) throw ErrorWithCode.Factory.BadRequest("TEAM_NOT_ALLOWED");
    return requested;
  }

  private assertOwningTeam(owningTeamId: number, requestedTeamId: number | undefined): void {
    if (requestedTeamId !== undefined && requestedTeamId !== owningTeamId) {
      throw ErrorWithCode.Factory.BadRequest("TEAM_NOT_ALLOWED");
    }
  }

  // eventOwnerProcedure does not check that the membership was accepted.
  private async assertActorIsMember(userId: number, teamId: number): Promise<void> {
    const isMember = await this.deps.membershipLookup.isAcceptedMember({ userId, teamId });
    if (!isMember) throw ErrorWithCode.Factory.Forbidden("NOT_ALLOWED");
  }

  private buildUnavailableDto(
    context: NotetakerEventTypeContext,
    unavailableReason: NotetakerSharingUnavailableReasonDto
  ): NotetakerEventTypeSharingDto {
    return {
      eventTypeId: context.id,
      available: false,
      unavailableReason,
      mode: "HOSTS_ONLY",
      teamName: null,
      people: [],
      setAt: null,
      setByName: null,
      teamId: null,
      teamOptions: [],
    };
  }

  private async buildPeople(
    eventTypeId: number,
    eligibilityTeamId: number
  ): Promise<NotetakerSharingPersonDto[]> {
    const { eventTypeNotetakerSettingsRepository, membershipLookup } = this.deps;
    const members = await eventTypeNotetakerSettingsRepository.findSharingMembersIncludeUser(eventTypeId);
    const eligibleIds = new Set(
      await membershipLookup.findAcceptedUserIds({
        teamId: eligibilityTeamId,
        userIds: members.map((member) => member.userId),
      })
    );
    return members.map((member) => ({
      userId: member.userId,
      name: member.name,
      email: member.email,
      avatarUrl: member.avatarUrl,
      stillEligible: eligibleIds.has(member.userId),
    }));
  }

  private async buildDto(
    context: NotetakerEventTypeContext,
    featureEnabled: boolean,
    target: SharingTarget
  ): Promise<NotetakerEventTypeSharingDto> {
    if (target.kind === "NONE") {
      return this.buildUnavailableDto(context, featureEnabled ? "NOT_A_TEAM_EVENT_TYPE" : "FEATURE_DISABLED");
    }
    if (target.kind === "PERSONAL" && target.teamOptions.length === 0) {
      return this.buildUnavailableDto(context, featureEnabled ? "NO_TEAM_TO_SHARE_WITH" : "FEATURE_DISABLED");
    }

    let teamId: number | null;
    let teamName: string | null;
    let people: NotetakerSharingPersonDto[];
    if (target.kind === "TEAM_EVENT_TYPE") {
      teamId = target.teamId;
      teamName = target.teamName;
      people = await this.buildPeople(context.id, target.eligibilityTeamId);
    } else {
      teamId = target.chosenTeam?.teamId ?? null;
      teamName = target.chosenTeam?.name ?? null;
      // Without a team in force the stored list names members of a team that no longer applies.
      people = target.chosenTeam ? await this.buildPeople(context.id, target.chosenTeam.teamId) : [];
    }

    const setByUserId = context.settings?.sharingSetByUserId ?? null;
    let setByName: string | null = null;
    if (setByUserId !== null) {
      const [setBy] = await this.deps.userRepository.findByIds({ ids: [setByUserId] });
      setByName = setBy ? (setBy.name ?? setBy.email) : null;
    }

    return {
      eventTypeId: context.id,
      available: featureEnabled,
      unavailableReason: featureEnabled ? null : "FEATURE_DISABLED",
      mode: context.settings?.sharingMode ?? "HOSTS_ONLY",
      teamName,
      people,
      setAt: context.settings?.sharingSetAt?.toISOString() ?? null,
      setByName,
      teamId,
      teamOptions: target.kind === "PERSONAL" ? target.teamOptions : [],
    };
  }
}
