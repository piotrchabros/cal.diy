import { MembershipRole } from "@calcom/prisma/enums";
import type { PrismaClient } from "@calcom/prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TeamProfileService } from "./TeamProfileService";

type PrismaMock = Pick<PrismaClient, "membership" | "team">;

const buildPrismaMock = () => ({
  membership: { findUnique: vi.fn() },
  team: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
});

const asPrisma = (mock: ReturnType<typeof buildPrismaMock>): PrismaMock =>
  mock as unknown as PrismaMock;

const ownerMembership = { id: 1, teamId: 10, userId: 7, accepted: true, role: MembershipRole.OWNER };
const adminMembership = { ...ownerMembership, role: MembershipRole.ADMIN };
const memberMembership = { ...ownerMembership, role: MembershipRole.MEMBER };

const baseTeam = {
  id: 10,
  name: "BlueBee",
  slug: "bluebee",
  logoUrl: null,
  bio: null,
  metadata: {},
  parentId: null,
};

describe("TeamProfileService", () => {
  let db: ReturnType<typeof buildPrismaMock>;
  let service: TeamProfileService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = buildPrismaMock();
    service = new TeamProfileService(asPrisma(db));
  });

  describe("getTeamProfile", () => {
    it("throws not_found when the user has no membership", async () => {
      db.membership.findUnique.mockResolvedValue(null);
      await expect(service.getTeamProfile({ teamId: 10, userId: 7 })).rejects.toThrow(
        /no accepted membership/
      );
    });

    it("throws not_found when the invite is still pending", async () => {
      db.membership.findUnique.mockResolvedValue({ ...memberMembership, accepted: false });
      await expect(service.getTeamProfile({ teamId: 10, userId: 7 })).rejects.toThrow(
        /no accepted membership/
      );
    });

    it("throws not_found when the team no longer exists", async () => {
      db.membership.findUnique.mockResolvedValue(memberMembership);
      db.team.findUnique.mockResolvedValue(null);
      await expect(service.getTeamProfile({ teamId: 10, userId: 7 })).rejects.toThrow(
        /does not exist/
      );
    });

    it("returns the profile with parsed location, map flag and socials", async () => {
      db.membership.findUnique.mockResolvedValue(memberMembership);
      db.team.findUnique.mockResolvedValue({
        ...baseTeam,
        metadata: {
          location: "London, UK",
          showMap: true,
          socialLinks: [{ platform: "x", url: "https://x.com/bluebee" }],
        },
      });
      const profile = await service.getTeamProfile({ teamId: 10, userId: 7 });
      expect(profile.role).toBe(MembershipRole.MEMBER);
      expect(profile.location).toBe("London, UK");
      expect(profile.showMap).toBe(true);
      expect(profile.socialLinks).toEqual([{ platform: "x", url: "https://x.com/bluebee" }]);
      expect(db.team.findUnique.mock.calls[0][0]).toHaveProperty("select");
      expect(db.team.findUnique.mock.calls[0][0].select).not.toHaveProperty("credentials");
    });

    it("falls back to defaults when metadata is malformed", async () => {
      db.membership.findUnique.mockResolvedValue(memberMembership);
      db.team.findUnique.mockResolvedValue({ ...baseTeam, metadata: { location: 42 } });
      const profile = await service.getTeamProfile({ teamId: 10, userId: 7 });
      expect(profile.location).toBeNull();
      expect(profile.showMap).toBe(false);
      expect(profile.socialLinks).toEqual([]);
    });
  });

  describe("updateTeamProfile", () => {
    const input = {
      teamId: 10,
      name: "BlueBee",
      slug: "bluebee",
      bio: "We build hives.",
      location: "London, UK",
      showMap: true,
      socialLinks: [{ platform: "x", url: "https://x.com/bluebee" }],
    };

    it("rejects members without admin or owner role", async () => {
      db.membership.findUnique.mockResolvedValue(memberMembership);
      await expect(service.updateTeamProfile({ teamId: 10, userId: 7, input })).rejects.toThrow(
        /not an admin or owner/
      );
    });

    it("rejects an already-taken slug", async () => {
      db.membership.findUnique.mockResolvedValue(adminMembership);
      db.team.findUnique.mockResolvedValue(baseTeam);
      db.team.findFirst.mockResolvedValue({ id: 99 });
      await expect(service.updateTeamProfile({ teamId: 10, userId: 7, input })).rejects.toThrow(
        /already taken/
      );
    });

    it("updates the team and merges profile metadata", async () => {
      db.membership.findUnique.mockResolvedValue(ownerMembership);
      db.team.findUnique.mockResolvedValue(baseTeam);
      db.team.findFirst.mockResolvedValue(null);
      db.team.update.mockResolvedValue({
        ...baseTeam,
        name: "BlueBee",
        metadata: { location: "London, UK", showMap: true, socialLinks: input.socialLinks },
      });
      const profile = await service.updateTeamProfile({ teamId: 10, userId: 7, input });
      expect(db.team.update).toHaveBeenCalledOnce();
      const data = db.team.update.mock.calls[0][0].data;
      expect(data.slug).toBe("bluebee");
      expect(profile.location).toBe("London, UK");
      expect(profile.showMap).toBe(true);
    });
  });

  describe("getPublicTeamBySlug", () => {
    const publicTeam = {
      ...baseTeam,
      isPrivate: false,
      eventTypes: [
        { id: 1, title: "Demo", slug: "demo", description: "Schedule a demo call with us", length: 15 },
      ],
    };

    it("returns null for an empty slug without querying", async () => {
      await expect(service.getPublicTeamBySlug({ slug: "   " })).resolves.toBeNull();
      expect(db.team.findFirst).not.toHaveBeenCalled();
    });

    it("returns null when no team matches the slug", async () => {
      db.team.findFirst.mockResolvedValue(null);
      await expect(service.getPublicTeamBySlug({ slug: "nope" })).resolves.toBeNull();
    });

    it("queries only public-safe fields and visible event types", async () => {
      db.team.findFirst.mockResolvedValue(publicTeam);
      await service.getPublicTeamBySlug({ slug: "BlueBee" });
      expect(db.team.findFirst).toHaveBeenCalledOnce();
      const args = db.team.findFirst.mock.calls[0][0];
      expect(args.where).toEqual({ slug: "bluebee", isPrivate: false });
      expect(args.select).not.toHaveProperty("credentials");
      expect(args.select).not.toHaveProperty("members");
      expect(args.select.eventTypes.where).toEqual({ hidden: false });
      expect(args.select.eventTypes.select).toEqual({
        id: true,
        title: true,
        slug: true,
        description: true,
        length: true,
      });
    });

    it("returns the public profile with location, socials and event types", async () => {
      db.team.findFirst.mockResolvedValue({
        ...publicTeam,
        metadata: {
          location: "London, UK",
          socialLinks: [{ platform: "x", url: "https://x.com/bluebee" }],
        },
      });
      const profile = await service.getPublicTeamBySlug({ slug: "bluebee" });
      expect(profile).toMatchObject({
        id: 10,
        name: "BlueBee",
        slug: "bluebee",
        location: "London, UK",
        socialLinks: [{ platform: "x", url: "https://x.com/bluebee" }],
      });
      expect(profile?.eventTypes).toHaveLength(1);
      expect(profile).not.toHaveProperty("credentials");
    });

    it("falls back to defaults when metadata is malformed", async () => {
      db.team.findFirst.mockResolvedValue({ ...publicTeam, metadata: { location: 42 } });
      const profile = await service.getPublicTeamBySlug({ slug: "bluebee" });
      expect(profile?.location).toBeNull();
      expect(profile?.socialLinks).toEqual([]);
    });
  });

  describe("disbandTeam", () => {
    it("rejects admins: only owners can disband", async () => {
      db.membership.findUnique.mockResolvedValue(adminMembership);
      await expect(service.disbandTeam({ teamId: 10, userId: 7 })).rejects.toThrow(
        /not the team owner/
      );
      expect(db.team.delete).not.toHaveBeenCalled();
    });

    it("rejects members: only owners can disband", async () => {
      db.membership.findUnique.mockResolvedValue(memberMembership);
      await expect(service.disbandTeam({ teamId: 10, userId: 7 })).rejects.toThrow(
        /not the team owner/
      );
    });

    it("deletes the team for the owner", async () => {
      db.membership.findUnique.mockResolvedValue(ownerMembership);
      db.team.findUnique.mockResolvedValue({ id: 10 });
      db.team.delete.mockResolvedValue({ id: 10 });
      await expect(service.disbandTeam({ teamId: 10, userId: 7 })).resolves.toEqual({ id: 10 });
      expect(db.team.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    });
  });
});
