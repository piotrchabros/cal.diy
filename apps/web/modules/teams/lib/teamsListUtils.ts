import type { MembershipRole } from "@prisma/client";

export type TeamsListTeam = {
  id: number;
  name: string;
  slug: string | null;
  logoUrl: string | null;
  bio: string | null;
  role: MembershipRole;
  publicUrl: string | null;
};

export function getTeamInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) {
    const word = words[0] as string;
    return word.slice(0, 2).toUpperCase();
  }
  const first = words[0] as string;
  const second = words[1] as string;
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export function getTeamPublicUrl(webappUrl: string, slug: string | null): string | null {
  if (!slug) return null;
  return `${webappUrl.replace(/\/$/, "")}/team/${slug}`;
}
