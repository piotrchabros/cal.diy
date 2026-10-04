import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { ErrorWithCode } from "@calcom/lib/errors";
import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";

import { TeamCreationService } from "./TeamCreationService";

describe("TeamCreationService", () => {
  describe("normalizeSlug", () => {
    it("normalizes a team name into a URL-safe slug", () => {
      expect(TeamCreationService.normalizeSlug("Acme Inc.")).toBe("acme-inc");
    });

    it("returns an empty slug for blank input", () => {
      expect(TeamCreationService.normalizeSlug("   ")).toBe("");
    });
  });

  describe("isSlugAvailable", () => {
    it("returns true when no team uses the slug", async () => {
      await expect(TeamCreationService.isSlugAvailable("brand-new-team")).resolves.toBe(true);
    });

    it("returns false when a team already uses the slug", async () => {
      await prismock.team.create({
        data: { name: "Taken", slug: "taken-slug" },
      });

      await expect(TeamCreationService.isSlugAvailable("taken-slug")).resolves.toBe(false);
    });

    it("returns false for an empty slug", async () => {
      await expect(TeamCreationService.isSlugAvailable("")).resolves.toBe(false);
    });
  });

  describe("createTeam", () => {
    it("creates a team and adds the creator as an accepted owner", async () => {
      const user = await prismock.user.create({
        data: { email: "founder@example.com", username: "founder" },
      });

      const team = await TeamCreationService.createTeam({
        userId: user.id,
        name: "Acme Inc.",
        slug: "acme",
        bio: "We build rockets.",
      });

      expect(team).toEqual(
        expect.objectContaining({
          name: "Acme Inc.",
          slug: "acme",
          bio: "We build rockets.",
        })
      );

      const membership = await prismock.membership.findFirst({
        where: { teamId: team.id, userId: user.id },
      });
      expect(membership).toEqual(
        expect.objectContaining({ role: MembershipRole.OWNER, accepted: true })
      );
    });

    it("throws when the slug is already taken", async () => {
      const user = await prismock.user.create({
        data: { email: "second@example.com", username: "second" },
      });
      await prismock.team.create({
        data: { name: "First", slug: "dupe" },
      });

      await expect(
        TeamCreationService.createTeam({ userId: user.id, name: "Second", slug: "dupe" })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });

    it("throws on an empty team name", async () => {
      const user = await prismock.user.create({
        data: { email: "noname@example.com", username: "noname" },
      });

      await expect(
        TeamCreationService.createTeam({ userId: user.id, name: "  ", slug: "valid-slug" })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });

    it("throws when the slug has no URL-safe characters left", async () => {
      const user = await prismock.user.create({
        data: { email: "badslug@example.com", username: "badslug" },
      });

      await expect(
        TeamCreationService.createTeam({ userId: user.id, name: "Bad", slug: "---" })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });
  });
});
