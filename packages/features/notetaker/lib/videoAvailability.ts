import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";

// Live sessions are still being recorded. A FAILED session either never got into the call or captured
// no speech, so it has no notes to go with a video and none is offered.
const NOTETAKER_RECORDED_SESSION_STATUSES: ReadonlySet<NotetakerSessionStatusDto> =
  new Set<NotetakerSessionStatusDto>(["READY", "ENDED_EARLY"]);

export function isNotetakerVideoDownloadable(
  session: Pick<NotetakerSessionRecord, "botProvider" | "externalRef" | "status" | "resultsDeletedAt">
): boolean {
  if (session.botProvider !== "RECALL") return false;
  if (!session.externalRef) return false;
  if (session.resultsDeletedAt !== null) return false;
  return NOTETAKER_RECORDED_SESSION_STATUSES.has(session.status);
}
