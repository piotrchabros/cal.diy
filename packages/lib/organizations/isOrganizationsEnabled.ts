import process from "node:process";
export function isOrganizationsEnabled(): boolean {
  return process.env.ORGANIZATIONS_ENABLED === "1" || process.env.ORGANIZATIONS_ENABLED === "true";
}
