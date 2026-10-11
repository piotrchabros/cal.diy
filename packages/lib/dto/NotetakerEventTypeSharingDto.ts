import { z } from "zod";

export type NotetakerSharingModeDto = "HOSTS_ONLY" | "TEAM" | "SELECTED_PEOPLE";

export const NotetakerSharingModeDtoSchema: z.ZodType<NotetakerSharingModeDto> = z.enum([
  "HOSTS_ONLY",
  "TEAM",
  "SELECTED_PEOPLE",
]);

export type NotetakerSharingUnavailableReasonDto =
  | "FEATURE_DISABLED"
  | "NOT_A_TEAM_EVENT_TYPE"
  | "NO_TEAM_TO_SHARE_WITH";

export type NotetakerSharingTeamOptionDto = { teamId: number; name: string };

export type NotetakerSharingPersonDto = {
  userId: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  stillEligible: boolean;
};

export type NotetakerEventTypeSharingDto = {
  eventTypeId: number;
  available: boolean;
  unavailableReason: NotetakerSharingUnavailableReasonDto | null;
  mode: NotetakerSharingModeDto;
  teamName: string | null;
  people: NotetakerSharingPersonDto[];
  setAt: string | null;
  setByName: string | null;
  /** Effective sharing team; null when a personal event type has none. Always sent by the server. */
  teamId?: number | null;
  /** Teams the owner may choose. Empty for a team event type. Always sent by the server. */
  teamOptions?: NotetakerSharingTeamOptionDto[];
};

export const NotetakerEventTypeSharingDtoSchema: z.ZodType<NotetakerEventTypeSharingDto> = z.object({
  eventTypeId: z.number().int(),
  available: z.boolean(),
  unavailableReason: z
    .enum(["FEATURE_DISABLED", "NOT_A_TEAM_EVENT_TYPE", "NO_TEAM_TO_SHARE_WITH"])
    .nullable(),
  mode: NotetakerSharingModeDtoSchema,
  teamName: z.string().nullable(),
  people: z.array(
    z.object({
      userId: z.number().int(),
      name: z.string().nullable(),
      email: z.string(),
      avatarUrl: z.string().nullable(),
      stillEligible: z.boolean(),
    })
  ),
  setAt: z.string().datetime().nullable(),
  setByName: z.string().nullable(),
  teamId: z.number().int().nullable().optional(),
  teamOptions: z.array(z.object({ teamId: z.number().int(), name: z.string() })).optional(),
});

export type NotetakerSharingCandidateDto = {
  userId: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
};

export type NotetakerSharingCandidatesDto = {
  items: NotetakerSharingCandidateDto[];
  nextCursor: number | null;
};

export const NOTETAKER_SHARING_MAX_PEOPLE = 50;
