import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamRepository } from "../repositories/TeamRepository";
import { TeamCreationService } from "./TeamCreationService";

const disableByFrom = vi.fn().mockResolvedValue(0);

// The real repository over prismock, so these tests pin the behaviour the Prisma queries had
// before they moved out of the service.
const service = new TeamCreationService({
  teamRepo: new TeamRepository(prismock as unknown as PrismaClient),
  tempOrgRedirectRepo: { disableByFrom },
});

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
      await expect(service.isSlugAvailable("brand-new-team")).resolves.toBe(true);
    });

    it("returns false when a team already uses the slug", async () => {
      await prismock.team.create({
        data: { name: "Taken", slug: "taken-slug" },
      });

      await expect(service.isSlugAvailable("taken-slug")).resolves.toBe(false);
    });

    it("returns false for an empty slug", async () => {
      await expect(service.isSlugAvailable("")).resolves.toBe(false);
    });

    it("scopes availability to the given organization", async () => {
      const org = await prismock.team.create({
        data: { name: "Org", slug: "org", isOrganization: true },
      });
      const otherOrg = await prismock.team.create({
        data: { name: "Other Org", slug: "other-org", isOrganization: true },
      });
      await prismock.team.create({
        data: { name: "Sales", slug: "sales", parentId: org.id },
      });

      await expect(service.isSlugAvailable("sales", org.id)).resolves.toBe(false);
      await expect(service.isSlugAvailable("sales", otherOrg.id)).resolves.toBe(true);
    });

    it("checks slugs globally when no organization is given", async () => {
      const org = await prismock.team.create({
        data: { name: "Org", slug: "org", isOrganization: true },
      });
      await prismock.team.create({
        data: { name: "Sales", slug: "sales", parentId: org.id },
      });

      await expect(service.isSlugAvailable("sales")).resolves.toBe(false);
      await expect(service.isSlugAvailable("sales", null)).resolves.toBe(false);
    });
  });

  describe("createTeam", () => {
    beforeEach(() => {
      disableByFrom.mockClear();
    });

    it("creates a team and adds the creator as an accepted owner", async () => {
      const user = await prismock.user.create({
        data: { email: "founder@example.com", username: "founder" },
      });

      const team = await service.createTeam({
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
      expect(membership).toEqual(expect.objectContaining({ role: MembershipRole.OWNER, accepted: true }));
    });

    it("throws when the slug is already taken", async () => {
      const user = await prismock.user.create({
        data: { email: "second@example.com", username: "second" },
      });
      await prismock.team.create({
        data: { name: "First", slug: "dupe" },
      });

      await expect(
        service.createTeam({ userId: user.id, name: "Second", slug: "dupe" })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });

    it("throws on an empty team name", async () => {
      const user = await prismock.user.create({
        data: { email: "noname@example.com", username: "noname" },
      });

      await expect(
        service.createTeam({ userId: user.id, name: "  ", slug: "valid-slug" })
      ).rejects.toBeInstanceOf(ErrorWithCode);
    });

    it("throws when the slug has no URL-safe characters left", async () => {
      const user = await prismock.user.create({
        data: { email: "badslug@example.com", username: "badslug" },
      });

      await expect(service.createTeam({ userId: user.id, name: "Bad", slug: "---" })).rejects.toBeInstanceOf(
        ErrorWithCode
      );
    });

    it("creates the team inside the given organization", async () => {
      const user = await prismock.user.create({
        data: { email: "org-founder@example.com", username: "org-founder" },
      });
      const org = await prismock.team.create({
        data: { name: "Org", slug: "org", isOrganization: true },
      });

      const team = await service.createTeam({
        userId: user.id,
        name: "Sales",
        slug: "sales",
        organizationId: org.id,
      });

      const stored = await prismock.team.findUnique({ where: { id: team.id } });
      expect(stored?.parentId).toBe(org.id);
      expect(disableByFrom).toHaveBeenCalledWith({
        fromOrgId: org.id,
        from: "sales",
        types: ["Team", "TeamEventType"],
      });
    });

    it("allows the same slug in a different organization", async () => {
      const user = await prismock.user.create({
        data: { email: "multi-org@example.com", username: "multi-org" },
      });
      const org = await prismock.team.create({
        data: { name: "Org", slug: "org", isOrganization: true },
      });
      const otherOrg = await prismock.team.create({
        data: { name: "Other Org", slug: "other-org", isOrganization: true },
      });
      await service.createTeam({
        userId: user.id,
        name: "Sales",
        slug: "sales",
        organizationId: org.id,
      });

      const team = await service.createTeam({
        userId: user.id,
        name: "Sales",
        slug: "sales",
        organizationId: otherOrg.id,
      });

      const stored = await prismock.team.findUnique({ where: { id: team.id } });
      expect(stored?.parentId).toBe(otherOrg.id);
    });

    it("throws a bad request when the slug is taken in the same organization", async () => {
      const user = await prismock.user.create({
        data: { email: "same-org@example.com", username: "same-org" },
      });
      const org = await prismock.team.create({
        data: { name: "Org", slug: "org", isOrganization: true },
      });
      await service.createTeam({
        userId: user.id,
        name: "Sales",
        slug: "sales",
        organizationId: org.id,
      });

      const result = service.createTeam({
        userId: user.id,
        name: "Sales Again",
        slug: "sales",
        organizationId: org.id,
      });

      await expect(result).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(result).rejects.toMatchObject({ code: ErrorCode.BadRequest });
    });

    it("creates a team without a parent when no organization is given", async () => {
      const user = await prismock.user.create({
        data: { email: "no-org@example.com", username: "no-org" },
      });

      const team = await service.createTeam({
        userId: user.id,
        name: "Solo",
        slug: "solo",
      });

      const stored = await prismock.team.findUnique({ where: { id: team.id } });
      expect(stored?.parentId).toBeNull();
      expect(disableByFrom).not.toHaveBeenCalled();
    });
  });

  describe("createTeam logo upload", () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const hostedUrl = "https://cdn.example.com/logos/team-1.png";

    function serviceWithUploadMock(uploadTeamLogo = vi.fn(async () => hostedUrl)) {
      return {
        service: new TeamCreationService(
          {
            teamRepo: new TeamRepository(prismock as unknown as PrismaClient),
            tempOrgRedirectRepo: { disableByFrom },
          },
          uploadTeamLogo
        ),
        uploadTeamLogo,
      };
    }

    it("uploads a data-URL logo and stores the hosted URL", async () => {
      const user = await prismock.user.create({
        data: { email: "logo@example.com", username: "logo" },
      });
      const { service: logoService, uploadTeamLogo } = serviceWithUploadMock();

      const team = await logoService.createTeam({
        userId: user.id,
        name: "Logo Team",
        slug: "logo-team",
        logoUrl: dataUrl,
      });

      expect(uploadTeamLogo).toHaveBeenCalledWith({ teamId: team.id, logo: dataUrl });
      expect(team.logoUrl).toBe(hostedUrl);
      const stored = await prismock.team.findUnique({ where: { id: team.id } });
      expect(stored?.logoUrl).toBe(hostedUrl);
    });

    it("stores a plain https logo URL as-is without uploading", async () => {
      const user = await prismock.user.create({
        data: { email: "plain-logo@example.com", username: "plain-logo" },
      });
      const { service: logoService, uploadTeamLogo } = serviceWithUploadMock();

      const team = await logoService.createTeam({
        userId: user.id,
        name: "Plain Logo Team",
        slug: "plain-logo-team",
        logoUrl: "https://example.com/logo.png",
      });

      expect(uploadTeamLogo).not.toHaveBeenCalled();
      expect(team.logoUrl).toBe("https://example.com/logo.png");
    });

    it("rejects an unsupported logo URL scheme", async () => {
      const user = await prismock.user.create({
        data: { email: "bad-logo@example.com", username: "bad-logo" },
      });

      await expect(
        service.createTeam({
          userId: user.id,
          name: "Bad Logo Team",
          slug: "bad-logo-team",
          logoUrl: "ftp://example.com/logo.png",
        })
      ).rejects.toMatchObject({ code: ErrorCode.BadRequest });
    });

    it("rejects a data URL that is not a supported image", async () => {
      const user = await prismock.user.create({
        data: { email: "bad-data-url@example.com", username: "bad-data-url" },
      });

      await expect(
        service.createTeam({
          userId: user.id,
          name: "Bad Data URL Team",
          slug: "bad-data-url-team",
          logoUrl: "data:text/plain;base64,aGVsbG8=",
        })
      ).rejects.toMatchObject({ code: ErrorCode.BadRequest });
    });
  });
});
