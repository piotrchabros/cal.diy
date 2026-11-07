import { randomString } from "@calcom/lib/random";
import slugify from "@calcom/lib/slugify";

// The random suffix keeps users who share a name or email local part from colliding on username;
// "user" covers bases that slugify reduces to "" (empty or symbol-only input).
export const usernameSlug = (base: string | null | undefined): string =>
  `${slugify(base ?? "") || "user"}-${randomString(6).toLowerCase()}`;
