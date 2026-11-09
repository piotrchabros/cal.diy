import { CAL_URL } from "@calcom/lib/constants";
import type { TextComponent } from "../lib";
import { isKnownOrganizationDomain } from "./organizationDomain";

/**
 * Check if the url is a valid cal.com url
 * @param url
 * @returns IsValid
 */
export async function isValidCalURL(url: string) {
  const regex = new RegExp(`^https://(?:[a-zA-Z0-9-]+\\.)?${CAL_URL.replace("https://", "")}/`, "i");

  const error: TextComponent = {
    type: "text",
    text: `This is not a valid ${CAL_URL.replace("https://", "")} link`,
    style: "error",
    align: "left",
  };

  if (!regex.test(url)) {
    // Organization custom domains are accepted the same way api/get.ts embeds them,
    // sharing its lookup so the two cannot drift apart. Inert while organizations are off.
    let hostname: string | null = null;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = null;
    }
    if (!hostname || !(await isKnownOrganizationDomain(hostname)))
      return {
        isValid: false,
        error,
      };
  }

  const response = await fetch(url);

  if (response.status !== 200)
    return {
      isValid: false,
      error,
    };

  return {
    isValid: true,
  };
}
