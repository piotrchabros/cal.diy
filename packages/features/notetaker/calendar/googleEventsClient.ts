// UNVERIFIED AGAINST THE REAL SERVICE: see specs/001-meeting-transcription/tasks.md T219
// Written from the typings and only type-checked; it was not run against a real Google credential.
// Remove this notice once T219 records a real check.
import { createGoogleCalendarServiceWithGoogleType } from "@calcom/app-store/googlecalendar/lib/CalendarService";
import { CredentialRepository } from "@calcom/features/credentials/repositories/CredentialRepository";
import type { INotetakerGoogleEventsClient } from "./GoogleCalendarGuestGateway";

export async function getNotetakerGoogleEventsClient(
  credentialId: number
): Promise<INotetakerGoogleEventsClient | null> {
  const credential = await CredentialRepository.findCredentialForCalendarServiceById({ id: credentialId });
  if (!credential || credential.type !== "google_calendar" || credential.invalid) return null;
  return createGoogleCalendarServiceWithGoogleType(credential).authedCalendar();
}
