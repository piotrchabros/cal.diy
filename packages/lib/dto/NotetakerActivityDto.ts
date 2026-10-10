import { z } from "zod";
import type { NotetakerSharingModeDto } from "./NotetakerEventTypeSharingDto";
import { NotetakerSharingModeDtoSchema } from "./NotetakerEventTypeSharingDto";

export type NotetakerStoredActivityActionDto =
  | "ENABLED"
  | "DISABLED"
  | "STOPPED"
  | "SHARED"
  | "SHARING_REVOKED"
  | "EXPORTED"
  | "DELETED"
  | "SUMMARY_REQUESTED"
  | "SHARED_VIEWED";

// The two sharing actions are derived from sharing-change rows at read time, so they are not in the Prisma enum.
export type NotetakerActivityActionDto =
  | NotetakerStoredActivityActionDto
  | "SHARING_MODE_CHANGED"
  | "SHARING_PEOPLE_CHANGED";

export type NotetakerSharingChangeDetailDto = {
  previousMode: NotetakerSharingModeDto;
  newMode: NotetakerSharingModeDto;
  addedUserNames: string[];
  removedUserNames: string[];
};

export const NotetakerSharingChangeDetailDtoSchema: z.ZodType<NotetakerSharingChangeDetailDto> = z.object({
  previousMode: NotetakerSharingModeDtoSchema,
  newMode: NotetakerSharingModeDtoSchema,
  addedUserNames: z.array(z.string()),
  removedUserNames: z.array(z.string()),
});

export type NotetakerActorTypeDto = "USER" | "PARTICIPANT" | "SYSTEM";

export type NotetakerActivityDto = {
  id: string;
  action: NotetakerActivityActionDto;
  actorType: NotetakerActorTypeDto;
  actorName: string | null;
  createdAt: string;
  detail: Record<string, unknown> | null;
};

export const NotetakerActivityDtoSchema: z.ZodType<NotetakerActivityDto> = z.object({
  id: z.string(),
  action: z.enum([
    "ENABLED",
    "DISABLED",
    "STOPPED",
    "SHARED",
    "SHARING_REVOKED",
    "EXPORTED",
    "DELETED",
    "SUMMARY_REQUESTED",
    "SHARED_VIEWED",
    "SHARING_MODE_CHANGED",
    "SHARING_PEOPLE_CHANGED",
  ]),
  actorType: z.enum(["USER", "PARTICIPANT", "SYSTEM"]),
  actorName: z.string().nullable(),
  createdAt: z.string().datetime(),
  detail: z.record(z.unknown()).nullable(),
});
