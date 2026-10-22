import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import { getTranslation } from "@calcom/i18n/server";
import type { NotetakerSharingTeamOptionDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import short from "short-uuid";
import { buildAdHocBookingMetadata, parseAdHocMeetingUrl } from "../lib/adHocMeeting";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { IEventTypeNotetakerSettingsRepository } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type { NotetakerChoiceService } from "./NotetakerChoiceService";
import type { NotetakerDispatchService } from "./NotetakerDispatchService";

const NOTETAKER_FEATURE_SLUG = "notetaker";
const translator = short();
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const NON_ASCII = /[^\x20-\x7E]/;
const MAX_REPORTED_CODE_POINTS = 5;

function listNonAsciiCodePoints(value: string): string[] {
  const codePoints = new Set<string>();
  for (const char of value) {
    if (!NON_ASCII.test(char)) continue;
    codePoints.add(`U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
    if (codePoints.size >= MAX_REPORTED_CODE_POINTS) break;
  }
  return Array.from(codePoints);
}

function adHocError(code: NotetakerAdHocErrorCode): ErrorWithCode {
  // Only the message reaches the client, so it carries the code itself.
  return ErrorWithCode.Factory.BadRequest(code);
}

export const NOTETAKER_AD_HOC_MAX_ACTIVE_MEETINGS = 1;
export const NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY = 10;
export const NOTETAKER_AD_HOC_DEFAULT_DURATION_MINUTES = 60;
export const NOTETAKER_AD_HOC_MIN_DURATION_MINUTES = 15;
export const NOTETAKER_AD_HOC_MAX_DURATION_MINUTES = 240;

export type NotetakerAdHocErrorCode =
  | "FEATURE_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_MEETING_LINK"
  | "UNSUPPORTED_PLATFORM"
  | "AD_HOC_LIMIT_REACHED"
  | "TEAM_NOT_ALLOWED"
  | "INVALID_DURATION";

export type NotetakerAdHocOptions = {
  featureEnabled: boolean;
  teamOptions: NotetakerSharingTeamOptionDto[];
  defaultDurationMinutes: number;
  maxDurationMinutes: number;
};

export interface INotetakerAdHocServiceDeps {
  bookingNotetakerRepository: Pick<
    IBookingNotetakerRepository,
    "createAdHocBooking" | "countAdHocByUserIdSince" | "findActiveAdHocByUserId"
  >;
  eventTypeNotetakerSettingsRepository: Pick<IEventTypeNotetakerSettingsRepository, "findTeamsByIds">;
  membershipLookup: Pick<INotetakerMembershipLookup, "listAcceptedTeamIds">;
  featuresRepository: Pick<IFeaturesRepository, "checkIfUserHasFeature">;
  choiceService: Pick<NotetakerChoiceService, "setEnabled">;
  dispatchService: Pick<NotetakerDispatchService, "dispatchForBooking">;
  userRepository: INotetakerUserLookup;
  config: NotetakerConfig;
  logger: ISimpleLogger;
}

export class NotetakerAdHocService {
  constructor(private readonly deps: INotetakerAdHocServiceDeps) {}

  async getOptions(params: { userId: number }): Promise<NotetakerAdHocOptions> {
    const { userId } = params;
    const featureEnabled = (await this.hasFeature(userId)) && isNotetakerBotProviderUsable(this.deps.config);
    const teamOptions = featureEnabled ? await this.listTeamOptions(userId) : [];
    return {
      featureEnabled,
      teamOptions,
      defaultDurationMinutes: this.defaultDurationMinutes(),
      maxDurationMinutes: this.maxDurationMinutes(),
    };
  }

  async dispatchToMeeting(params: {
    userId: number;
    meetingUrl: string;
    title?: string;
    durationMinutes?: number;
    sharingTeamId: number | null;
  }): Promise<{ bookingUid: string; reused: boolean }> {
    const { userId, sharingTeamId } = params;
    const { bookingNotetakerRepository, membershipLookup, choiceService, dispatchService, logger } =
      this.deps;

    if (!(await this.hasFeature(userId))) throw adHocError("FEATURE_DISABLED");
    if (!isNotetakerBotProviderUsable(this.deps.config)) throw adHocError("PROVIDER_UNAVAILABLE");

    const link = parseAdHocMeetingUrl(params.meetingUrl);
    if (!link.ok) {
      // The link itself is user content, so only its shape is logged to tell paste artifacts from bad links.
      logger.warn("Notetaker ad-hoc meeting link rejected", {
        reason: link.reason,
        rawLength: params.meetingUrl.length,
        nonAsciiCodePoints: listNonAsciiCodePoints(params.meetingUrl),
      });
      throw adHocError(link.reason);
    }

    const now = new Date();
    const active = await bookingNotetakerRepository.findActiveAdHocByUserId({ userId, now });
    // Pasting the same link again, e.g. after a reload, returns the live meeting instead of a second bot.
    const sameMeeting = active.find((meeting) => meeting.location === link.meetingUrl);
    if (sameMeeting) return { bookingUid: sameMeeting.bookingUid, reused: true };

    if (active.length >= NOTETAKER_AD_HOC_MAX_ACTIVE_MEETINGS) throw adHocError("AD_HOC_LIMIT_REACHED");
    const createdToday = await bookingNotetakerRepository.countAdHocByUserIdSince({
      userId,
      since: new Date(now.getTime() - DAY_MS),
    });
    if (createdToday >= NOTETAKER_AD_HOC_MAX_MEETINGS_PER_DAY) throw adHocError("AD_HOC_LIMIT_REACHED");

    if (sharingTeamId !== null) {
      const teamIds = await membershipLookup.listAcceptedTeamIds({ userId });
      if (!teamIds.includes(sharingTeamId)) throw adHocError("TEAM_NOT_ALLOWED");
    }

    const durationMinutes = params.durationMinutes ?? this.defaultDurationMinutes();
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < NOTETAKER_AD_HOC_MIN_DURATION_MINUTES ||
      durationMinutes > this.maxDurationMinutes()
    ) {
      throw adHocError("INVALID_DURATION");
    }

    const title = params.title?.trim() || (await this.defaultTitle(userId));
    const booking = await bookingNotetakerRepository.createAdHocBooking({
      uid: translator.generate(),
      userId,
      title,
      startTime: now,
      endTime: new Date(now.getTime() + durationMinutes * MINUTE_MS),
      location: link.meetingUrl,
      metadata: buildAdHocBookingMetadata({ sharingTeamId }),
    });

    await choiceService.setEnabled({ bookingUid: booking.uid, enabled: true, scope: "THIS_BOOKING", userId });
    try {
      await dispatchService.dispatchForBooking({ bookingUid: booking.uid });
    } catch (error) {
      // The choice stays armed, so the dispatch sweep retries this booking on its next run.
      logger.warn("Notetaker ad-hoc dispatch failed; the sweep will retry", { bookingId: booking.id });
      throw error;
    }

    return { bookingUid: booking.uid, reused: false };
  }

  private async hasFeature(userId: number): Promise<boolean> {
    return this.deps.featuresRepository.checkIfUserHasFeature(userId, NOTETAKER_FEATURE_SLUG);
  }

  private async listTeamOptions(userId: number): Promise<NotetakerSharingTeamOptionDto[]> {
    const teamIds = await this.deps.membershipLookup.listAcceptedTeamIds({ userId });
    const teams = await this.deps.eventTypeNotetakerSettingsRepository.findTeamsByIds({ teamIds });
    return teams.map(({ teamId, teamName }) => ({ teamId, name: teamName }));
  }

  // The bot leaves at the configured limit regardless of the booking, so a longer booking would end empty.
  private maxDurationMinutes(): number {
    return Math.min(
      NOTETAKER_AD_HOC_MAX_DURATION_MINUTES,
      Math.floor(this.deps.config.limits.maxDurationSeconds / 60)
    );
  }

  private defaultDurationMinutes(): number {
    return Math.min(NOTETAKER_AD_HOC_DEFAULT_DURATION_MINUTES, this.maxDurationMinutes());
  }

  private async defaultTitle(userId: number): Promise<string> {
    const [user] = await this.deps.userRepository.findByIds({ ids: [userId] });
    const t = await getTranslation(user?.locale ?? "en", "common");
    return t("notetaker_ad_hoc_default_title");
  }
}
