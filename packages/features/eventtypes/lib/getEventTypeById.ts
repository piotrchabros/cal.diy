//import "server-only";
import type { LocationObject } from "@calcom/app-store/locations";
import { getLocationGroupedOptions } from "@calcom/app-store/server";
import { getEventTypeAppData } from "@calcom/app-store/utils";
import { eventTypeMetaDataSchemaWithTypedApps } from "@calcom/app-store/zod-utils";
import { getBookingFieldsWithSystemFields } from "@calcom/features/bookings/lib/getBookingFields";
import { DestinationCalendarRepository } from "@calcom/features/calendars/repositories/DestinationCalendarRepository";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { getTranslation } from "@calcom/i18n/server";
import { WEBSITE_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { parseBookingLimit } from "@calcom/lib/intervalLimits/isBookingLimits";
import { parseDurationLimit } from "@calcom/lib/intervalLimits/isDurationLimits";
import { parseEventTypeColor } from "@calcom/lib/isEventTypeColor";
import { parseRecurringEvent } from "@calcom/lib/isRecurringEvent";
import { getTeamOrganizationId } from "@calcom/lib/organizations/getTeamOrganizationId";
import { withoutOrganizationParent } from "@calcom/lib/organizations/withoutOrganizationParent";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole, SchedulingType } from "@calcom/prisma/enums";
import { customInputSchema } from "@calcom/prisma/zod-utils";

interface getEventTypeByIdProps {
  eventTypeId: number;
  userId: number;
  prisma: PrismaClient;
  isUserOrganizationAdmin: boolean;
  currentOrganizationId: number | null;
  userLocale?: string | null;
}

export type EventType = Awaited<ReturnType<typeof getEventTypeById>>;

export const getEventTypeById = async ({
  currentOrganizationId,
  eventTypeId,
  userId,
  prisma,
  isUserOrganizationAdmin,
  userLocale,
}: getEventTypeByIdProps) => {
  const fetchedEventType = await getRawEventType({
    userId,
    eventTypeId,
    isUserOrganizationAdmin,
    currentOrganizationId,
    prisma,
  });

  if (!fetchedEventType) {
    throw new ErrorWithCode(ErrorCode.NotFound, `Event type ${eventTypeId} not found`);
  }

  const rawEventType = {
    ...fetchedEventType,
    team: fetchedEventType.team ? withoutOrganizationParent(fetchedEventType.team) : null,
  };

  const { locations, metadata, ...restEventType } = rawEventType;
  const newMetadata = eventTypeMetaDataSchemaWithTypedApps.parse(metadata || {}) || {};
  const apps = newMetadata?.apps || {};
  const eventTypeWithParsedMetadata = { ...rawEventType, metadata: newMetadata };
  const userRepo = new UserRepository(prisma);
  const eventTeamMembershipsWithUserProfile = [];
  for (const eventTeamMembership of rawEventType.team?.members || []) {
    eventTeamMembershipsWithUserProfile.push({
      ...eventTeamMembership,
      user: await userRepo.enrichUserWithItsProfile({
        user: eventTeamMembership.user,
      }),
    });
  }

  const childrenWithUserProfile = [];
  for (const child of rawEventType.children || []) {
    childrenWithUserProfile.push({
      ...child,
      owner: child.owner
        ? await userRepo.enrichUserWithItsProfile({
            user: child.owner,
          })
        : null,
    });
  }

  const eventTypeUsersWithUserProfile = [];
  for (const eventTypeUser of rawEventType.users) {
    eventTypeUsersWithUserProfile.push(
      await userRepo.enrichUserWithItsProfile({
        user: eventTypeUser,
      })
    );
  }

  newMetadata.apps = {
    ...apps,
    giphy: getEventTypeAppData(eventTypeWithParsedMetadata, "giphy", true) ?? undefined,
  };

  const parsedMetaData = newMetadata;

  const parsedCustomInputs = (rawEventType.customInputs || []).map((input) => customInputSchema.parse(input));

  const eventType = {
    ...restEventType,
    schedule:
      rawEventType.schedule?.id ||
      (!rawEventType.team ? rawEventType.users[0]?.defaultScheduleId : null) ||
      null,
    restrictionScheduleId: rawEventType.restrictionScheduleId || null,
    restrictionScheduleName: rawEventType.restrictionSchedule?.name || null,
    useBookerTimezone: rawEventType.useBookerTimezone || false,
    instantMeetingSchedule: rawEventType.instantMeetingSchedule?.id || null,
    scheduleName: rawEventType.schedule?.name || null,
    recurringEvent: parseRecurringEvent(restEventType.recurringEvent),
    bookingLimits: parseBookingLimit(restEventType.bookingLimits),
    durationLimits: parseDurationLimit(restEventType.durationLimits),
    eventTypeColor: parseEventTypeColor(restEventType.eventTypeColor),
    locations: locations as unknown as LocationObject[],
    metadata: parsedMetaData,
    customInputs: parsedCustomInputs,
    users: rawEventType.users,
    bookerUrl: restEventType.team
      ? await getOrganizationUrlService().getBaseUrl({
          organizationId: getTeamOrganizationId(restEventType.team),
        })
      : restEventType.owner
        ? await getOrganizationUrlService().getBaseUrl({ organizationId: currentOrganizationId })
        : WEBSITE_URL,
    children: childrenWithUserProfile.flatMap((ch) =>
      ch.owner !== null
        ? {
            ...ch,
            owner: {
              ...ch.owner,
              avatar: getUserAvatarUrl(ch.owner),
              email: ch.owner.email,
              name: ch.owner.name ?? "",
              username: ch.owner.username ?? "",
              membership:
                restEventType.team?.members.find((tm) => tm.user.id === ch.owner?.id)?.role ||
                MembershipRole.MEMBER,
            },
            created: true,
          }
        : []
    ),
  };

  // backwards compat
  if (eventType.users.length === 0 && !eventType.team) {
    const fallbackUser = await userRepo.findFallbackById({ id: userId });
    if (!fallbackUser) {
      throw new ErrorWithCode(
        ErrorCode.NotFound,
        "The event type doesn't have user and no fallback user was found"
      );
    }
    eventType.users.push(fallbackUser);
  }

  const eventTypeUsers: ((typeof eventType.users)[number] & { avatar: string })[] =
    eventTypeUsersWithUserProfile.map((user) => ({
      ...user,
      avatar: getUserAvatarUrl(user),
    }));

  const currentUser = eventType.users.find((u) => u.id === userId);

  const t = await getTranslation(userLocale ?? currentUser?.locale ?? "en", "common");

  if (!currentUser?.id && !eventType.teamId) {
    throw new ErrorWithCode(ErrorCode.NotFound, "Could not find user or team");
  }

  const locationOptions = await getLocationGroupedOptions(
    eventType.teamId ? { teamId: eventType.teamId } : { userId },
    t
  );
  if (eventType.schedulingType === SchedulingType.MANAGED) {
    locationOptions.splice(0, 0, {
      label: t("default"),
      options: [
        {
          label: t("members_default_location"),
          value: "",
          icon: "/user-check.svg",
        },
      ],
    });
  }

  const isOrgTeamEvent = !!eventType?.teamId && !!eventType.team?.parentId;
  const eventTypeObject = Object.assign({}, eventType, {
    users: eventTypeUsers,
    periodStartDate: eventType.periodStartDate?.toString() ?? null,
    periodEndDate: eventType.periodEndDate?.toString() ?? null,
    bookingFields: getBookingFieldsWithSystemFields({ ...eventType, isOrgTeamEvent }),
  });

  const isOrgEventType = !!eventTypeObject.team?.parentId;
  const teamMembers = eventTypeObject.team
    ? eventTeamMembershipsWithUserProfile
        .filter((member) => member.accepted || isOrgEventType)
        .map((member) => {
          const user: typeof member.user & { avatar: string } = {
            ...member.user,
            avatar: getUserAvatarUrl(member.user),
          };
          return {
            ...user,
            profileId: user.profile.id,
            eventTypes: user.eventTypes.map((evTy) => evTy.slug),
            membership: member.role,
          };
        })
    : [];

  // Find the current users membership so we can check role to enable/disable deletion.
  // Sets to null if no membership is found - this must mean we are in a none team event type
  const currentUserMembership = eventTypeObject.team?.members.find((el) => el.user.id === userId) ?? null;

  let destinationCalendar = eventTypeObject.destinationCalendar;
  if (!destinationCalendar) {
    destinationCalendar = await new DestinationCalendarRepository(prisma).findDefaultByUserId({
      userId,
    });
  }

  const finalObj = {
    eventType: eventTypeObject,
    locationOptions,
    destinationCalendar,
    team: eventTypeObject.team || null,
    teamMembers,
    currentUserMembership,
    isUserOrganizationAdmin,
  };
  return finalObj;
};

export async function getRawEventType({
  userId,
  eventTypeId,
  isUserOrganizationAdmin,
  currentOrganizationId,
  prisma,
}: getEventTypeByIdProps) {
  const eventTypeRepo = new EventTypeRepository(prisma);

  // Platform org admins can access any event type within their organization
  if (isUserOrganizationAdmin && currentOrganizationId) {
    const org = await new TeamRepository(prisma).findIsPlatformById({
      teamId: currentOrganizationId,
    });

    if (org?.isPlatform) {
      const orgResult = await eventTypeRepo.findByIdForOrgAdmin({
        id: eventTypeId,
        organizationId: currentOrganizationId,
      });
      if (orgResult) return orgResult;
    }
  }

  return await eventTypeRepo.findById({
    id: eventTypeId,
    userId,
  });
}

export default getEventTypeById;
