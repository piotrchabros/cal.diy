import { z } from "zod";

export type NotetakerActivityActionDto =
  | "ENABLED"
  | "DISABLED"
  | "STOPPED"
  | "SHARED"
  | "SHARING_REVOKED"
  | "EXPORTED"
  | "DELETED"
  | "SUMMARY_REQUESTED";

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
  ]),
  actorType: z.enum(["USER", "PARTICIPANT", "SYSTEM"]),
  actorName: z.string().nullable(),
  createdAt: z.string().datetime(),
  detail: z.record(z.unknown()).nullable(),
});
