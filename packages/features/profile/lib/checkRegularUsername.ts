import process from "node:process";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import type { UsernameNamespace } from "@calcom/lib/server/username";
import { isUsernameReservedDueToMigration } from "@calcom/lib/server/username";
import slugify from "@calcom/lib/slugify";

const findUserInNamespace = async (username: string, namespace: NonNullable<UsernameNamespace>) => {
  if ("organizationId" in namespace) {
    const profile = await ProfileRepository.findByOrgIdAndUsername({
      organizationId: namespace.organizationId,
      username,
    });
    return profile?.user ?? null;
  }

  const profiles = await ProfileRepository.findManyByOrgSlugOrRequestedSlug({
    orgSlug: namespace.orgSlug,
    usernames: [username],
  });
  return profiles.length ? profiles[0].user : null;
};

export async function checkRegularUsername(_username: string, namespace: UsernameNamespace = null) {
  const username = slugify(_username);

  const premium = !!process.env.NEXT_PUBLIC_IS_E2E && username.length < 5;

  const user = namespace ? await findUserInNamespace(username, namespace) : null;

  if (user) {
    return {
      available: false as const,
      premium,
      message: "A user exists with that username",
    };
  }

  // Moved-user redirects only reserve usernames in the global namespace, never inside an organization.
  const isUsernameAvailable = namespace ? true : !(await isUsernameReservedDueToMigration(username));

  return {
    available: isUsernameAvailable,
    premium,
  };
}
