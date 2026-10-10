import { z } from "zod";

export type NotetakerSharingModeDto = "HOSTS_ONLY" | "TEAM" | "SELECTED_PEOPLE";

export const NotetakerSharingModeDtoSchema: z.ZodType<NotetakerSharingModeDto> = z.enum([
  "HOSTS_ONLY",
  "TEAM",
  "SELECTED_PEOPLE",
]);

export type NotetakerSharingUnavailableReasonDto = "FEATURE_DISABLED" | "NOT_A_TEAM_EVENT_TYPE";

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
};

export const NotetakerEventTypeSharingDtoSchema: z.ZodType<NotetakerEventTypeSharingDto> = z.object({
  eventTypeId: z.number().int(),
  available: z.boolean(),
  unavailableReason: z.enum(["FEATURE_DISABLED", "NOT_A_TEAM_EVENT_TYPE"]).nullable(),
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
