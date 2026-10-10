import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import type {
  NotetakerEventTypeSharingDto,
  NotetakerSharingCandidatesDto,
  NotetakerSharingModeDto,
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
    return this.buildDto(context, featureEnabled);
  }

  async set(params: {
    eventTypeId: number;
    mode: NotetakerSharingModeDto;
    userIds?: number[];
    userId: number;
  }): Promise<NotetakerEventTypeSharingDto> {
    const { eventTypeId, mode, userId } = params;
    const { eventTypeNotetakerSettingsRepository, membershipLookup, userRepository } = this.deps;

    const context = await this.getEventTypeOrThrow(eventTypeId);
    if (!(await this.isFeatureEnabled(userId))) {
      throw ErrorWithCode.Factory.Forbidden("FEATURE_DISABLED");
    }

    const eligibilityTeamId = this.getEligibilityTeamId(context);
    if (eligibilityTeamId === null) {
      if (mode !== "HOSTS_ONLY" || (params.userIds?.length ?? 0) > 0) {
        throw ErrorWithCode.Factory.BadRequest("NOT_A_TEAM_EVENT_TYPE");
      }
      return this.buildDto(context, true);
    }

    await this.assertActorIsMember(userId, eligibilityTeamId);

    const previousMode = context.settings?.sharingMode ?? "HOSTS_ONLY";
    const replacesList = mode === "SELECTED_PEOPLE" && params.userIds !== undefined;

    let memberUserIds: number[] | undefined;
    let addedUserNames: string[] = [];
    let removedUserNames: string[] = [];

    if (replacesList) {
      memberUserIds = Array.from(new Set(params.userIds));
      if (memberUserIds.length > NOTETAKER_SHARING_MAX_PEOPLE) {
        throw ErrorWithCode.Factory.BadRequest("TOO_MANY_PEOPLE");
      }

      const eligibleIds = new Set(
        await membershipLookup.findAcceptedUserIds({ teamId: eligibilityTeamId, userIds: memberUserIds })
      );
      // The message carries neither id nor name, so a probe cannot learn who exists.
      if (memberUserIds.some((id) => !eligibleIds.has(id))) {
        throw ErrorWithCode.Factory.BadRequest("PERSON_NOT_ELIGIBLE");
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
      mode === previousMode && addedUserNames.length === 0 && removedUserNames.length === 0;
    if (nothingChanged) return this.buildDto(context, true);

    const [actor] = await userRepository.findByIds({ ids: [userId] });
    await eventTypeNotetakerSettingsRepository.updateSharing({
      eventTypeId,
      sharingMode: mode,
      sharingSetByUserId: userId,
      sharingSetAt: new Date(),
      memberUserIds,
      change: {
        actorUserId: userId,
        actorName: actor ? (actor.name ?? actor.email) : null,
        previousMode,
        newMode: mode,
        addedUserNames,
        removedUserNames,
      },
    });

    return this.get({ eventTypeId, userId });
  }

  async listCandidates(params: {
    eventTypeId: number;
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

    const eligibilityTeamId = this.getEligibilityTeamId(context);
    if (eligibilityTeamId === null) {
      throw ErrorWithCode.Factory.BadRequest("NOT_A_TEAM_EVENT_TYPE");
    }

    await this.assertActorIsMember(userId, eligibilityTeamId);

    const limit = Math.min(MAX_CANDIDATE_LIMIT, Math.max(1, params.limit ?? DEFAULT_CANDIDATE_LIMIT));
    const search = params.search?.trim() || null;
    const page = await this.deps.membershipLookup.searchAcceptedMembers({
      teamId: eligibilityTeamId,
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

  // Colleagues are drawn from the organization when there is one, so a team can share with
  // anyone in the organization it belongs to.
  private getEligibilityTeamId(context: NotetakerEventTypeContext): number | null {
    if (context.teamId === null) return null;
    return context.organizationId ?? context.teamId;
  }

  // eventOwnerProcedure does not check that the membership was accepted.
  private async assertActorIsMember(userId: number, teamId: number): Promise<void> {
    const isMember = await this.deps.membershipLookup.isAcceptedMember({ userId, teamId });
    if (!isMember) throw ErrorWithCode.Factory.Forbidden("NOT_ALLOWED");
  }

  private async buildDto(
    context: NotetakerEventTypeContext,
    featureEnabled: boolean
  ): Promise<NotetakerEventTypeSharingDto> {
    const eligibilityTeamId = this.getEligibilityTeamId(context);
    const available = featureEnabled && eligibilityTeamId !== null;

    if (eligibilityTeamId === null) {
      return {
        eventTypeId: context.id,
        available,
        unavailableReason: featureEnabled ? "NOT_A_TEAM_EVENT_TYPE" : "FEATURE_DISABLED",
        mode: "HOSTS_ONLY",
        teamName: null,
        people: [],
        setAt: null,
        setByName: null,
      };
    }

    const { eventTypeNotetakerSettingsRepository, membershipLookup, userRepository } = this.deps;
    const members = await eventTypeNotetakerSettingsRepository.findSharingMembersIncludeUser(context.id);
    const eligibleIds = new Set(
      await membershipLookup.findAcceptedUserIds({
        teamId: eligibilityTeamId,
        userIds: members.map((member) => member.userId),
      })
    );

    const setByUserId = context.settings?.sharingSetByUserId ?? null;
    let setByName: string | null = null;
    if (setByUserId !== null) {
      const [setBy] = await userRepository.findByIds({ ids: [setByUserId] });
      setByName = setBy ? (setBy.name ?? setBy.email) : null;
    }

    return {
      eventTypeId: context.id,
      available,
      unavailableReason: featureEnabled ? null : "FEATURE_DISABLED",
      mode: context.settings?.sharingMode ?? "HOSTS_ONLY",
      teamName: context.teamName,
      people: members.map((member) => ({
        userId: member.userId,
        name: member.name,
        email: member.email,
        avatarUrl: member.avatarUrl,
        stillEligible: eligibleIds.has(member.userId),
      })),
      setAt: context.settings?.sharingSetAt?.toISOString() ?? null,
      setByName,
    };
  }
}
