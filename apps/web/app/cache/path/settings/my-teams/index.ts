"use server";

import { revalidatePath } from "next/cache";

export async function revalidateSettingsTeamProfile(teamId: number) {
  revalidatePath(`/settings/my-teams/${teamId}/profile`);
}
