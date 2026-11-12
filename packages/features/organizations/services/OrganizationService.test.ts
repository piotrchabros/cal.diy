import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationMembershipRepository } from "../tests/InMemoryOrganizationMembershipRepository";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { OrganizationMembershipService } from "./OrganizationMembershipService";
import type { OrganizationsConfig } from "./OrganizationService";
import { OrganizationService } from "./OrganizationService";

const { mockLogInfo, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ info: mockLogInfo, error: mockLogError }) },
}));

const DEFAULT_DOMAIN = "cal.example.com";
const ACTOR_ID = 100;
const OWNER_ID = 1;
const OWNER = { userId: OWNER_ID };
// Every user already belongs to an organization (the owner's is not one these tests create)
const OWNER_HOME_ORG_ID = 900;
const INVITED_ID = 500;

const SLUG_INVALID = "organization_slug_invalid";
const DOMAIN_INVALID = "organization_domain_invalid";
const NAME_INVALID = "organization_name_invalid";
const NOT_FOUND = "organization_not_found";

async function expectRejection(promise: Promise<unknown>, code: ErrorCode, message: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

describe("OrganizationService", () => {
  let repository: InMemoryOrganizationRepository;
  let membershipRepo: InMemoryOrganizationMembershipRepository;
  let service: OrganizationService;
  let moveUser: ReturnType<typeof vi.fn>;
  let findInviteeByEmail: ReturnType<typeof vi.fn>;
  let createInvitedWithPendingTeamMembership: ReturnType<typeof vi.fn>;
  let sendInvite: ReturnType<typeof vi.fn>;
  let uploadLogo: ReturnType<typeof vi.fn>;

  function buildService(
    config: OrganizationsConfig = { defaultDomain: DEFAULT_DOMAIN }
  ): OrganizationService {
    return new OrganizationService(
      {
        organizationRepository: repository,
        organizationsConfig: config,
        organizationMembershipService: new OrganizationMembershipService({
          organizationMembershipRepository: membershipRepo,
          organizationRepository: repository,
          organizationsConfig: config,
          userRepository: { findInviteeByEmail, createInvitedWithPendingTeamMembership },
          teamInviteService: { sendInvite },
          tempOrgRedirectRepository: {
            disableByFrom: vi.fn().mockResolvedValue(0),
            updateToUrl: vi.fn().mockResolvedValue(0),
          },
          organizationMoveService: { moveUser },
          organizationUrlService: { getBaseUrl: vi.fn().mockResolvedValue("https://acme.com") },
        }),
        organizationMoveService: { moveUser },
      },
      uploadLogo
    );
  }

  function ownerUser() {
    return membershipRepo.users.find((user) => user.id === OWNER_ID);
  }

  beforeEach(() => {
    mockLogInfo.mockClear();
    mockLogError.mockClear();
    uploadLogo = vi.fn().mockResolvedValue("/api/avatar/logo.png");
    repository = new InMemoryOrganizationRepository();
    membershipRepo = new InMemoryOrganizationMembershipRepository();
    membershipRepo.seedUser({ id: OWNER_ID, username: "owner", organizationId: OWNER_HOME_ORG_ID });
    moveUser = vi.fn().mockResolvedValue({ userId: OWNER_ID, organizationId: 0, username: "owner" });
    findInviteeByEmail = vi.fn().mockResolvedValue(null);
    createInvitedWithPendingTeamMembership = vi.fn().mockResolvedValue({ id: INVITED_ID, locale: null });
    sendInvite = vi.fn().mockResolvedValue(undefined);
    service = buildService();
  });

  describe("create", () => {
    it("creates an organization with trimmed name, normalized slug and domain", async () => {
      const created = await service.create(
        {
          name: "  Acme  ",
          slug: " ACME-Inc ",
          domain: "Acme.COM:3000",
          owner: OWNER,
          confirmMoveOwner: true,
        },
        ACTOR_ID
      );

      expect(created).toMatchObject({
        name: "Acme",
        slug: "acme-inc",
        domain: "acme.com",
        isDefault: false,
        memberCount: 0,
        teamCount: 0,
      });
      expect(repository.all()).toHaveLength(1);
    });

    describe("owner", () => {
      const input = { name: "Acme", slug: "acme", domain: "acme.com" };

      it("moves the owner in as OWNER and logs ids only", async () => {
        const created = await service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID);

        expect(moveUser).toHaveBeenCalledWith(
          { userId: OWNER_ID, toOrganizationId: created.id, role: "OWNER" },
          ACTOR_ID
        );
        expect(mockLogInfo).toHaveBeenCalledWith("organization.create", {
          action: "organization.create",
          actorUserId: ACTOR_ID,
          organizationId: created.id,
          ownerUserId: OWNER_ID,
        });
      });

      it("rejects an unknown owner and creates nothing", async () => {
        await expectRejection(
          service.create({ ...input, owner: { userId: 999 } }, ACTOR_ID),
          ErrorCode.NotFound,
          "organization_owner_not_found"
        );
        expect(repository.all()).toHaveLength(0);
        expect(mockLogInfo).not.toHaveBeenCalled();
      });

      it("asks for confirmation before moving the owner out of their organization", async () => {
        await expectRejection(
          service.create({ ...input, owner: OWNER }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "owner_in_another_organization"
        );
        expect(repository.all()).toHaveLength(0);
        expect(moveUser).not.toHaveBeenCalled();
      });

      describe("confirmed owner from another organization", () => {
        let addMember: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
          const other = repository.seed({ name: "Globex", slug: "globex", domain: "globex.com" });
          membershipRepo.seedUser({ id: OWNER_ID, username: "owner", organizationId: other.id });
          addMember = vi.spyOn(membershipRepo, "addMember");
        });

        it("moves the owner in as OWNER instead of adding them", async () => {
          const created = await service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID);

          expect(moveUser).toHaveBeenCalledWith(
            { userId: OWNER_ID, toOrganizationId: created.id, role: "OWNER" },
            ACTOR_ID
          );
          expect(addMember).not.toHaveBeenCalled();
        });

        it("deletes the organization and rethrows when the move fails", async () => {
          const failure = ErrorWithCode.Factory.Conflict("username_taken_in_target_organization");
          moveUser.mockRejectedValue(failure);

          await expect(
            service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID)
          ).rejects.toBe(failure);
          expect(repository.all()).toHaveLength(1);
          expect(repository.all()[0].slug).toBe("globex");
        });
      });

      it("rejects an owner without a username", async () => {
        membershipRepo.seedUser({ id: OWNER_ID, username: null, organizationId: OWNER_HOME_ORG_ID });

        await expectRejection(
          service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "organization_owner_needs_username"
        );
        expect(repository.all()).toHaveLength(0);
      });

      it.each([
        ["slug", { slug: "acme", domain: "other.com" }, "organization_slug_taken"],
        ["domain", { slug: "other", domain: "acme.com" }, "organization_domain_taken"],
      ])("leaves the owner untouched on a %s conflict", async (_label, taken, message) => {
        repository.seed({ name: "Other", ...taken });

        await expectRejection(
          service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID),
          ErrorCode.Conflict,
          message
        );
        expect(ownerUser()?.organizationId).toBe(OWNER_HOME_ORG_ID);
        expect(moveUser).not.toHaveBeenCalled();
      });

      it("deletes the organization and rethrows when moving the owner fails", async () => {
        const failure = ErrorWithCode.Factory.Conflict("x");
        moveUser.mockRejectedValue(failure);

        await expect(
          service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID)
        ).rejects.toBe(failure);
        expect(repository.all()).toEqual([]);
        expect(mockLogInfo).not.toHaveBeenCalled();
      });

      it("surfaces the original error when the compensating delete also fails", async () => {
        const failure = ErrorWithCode.Factory.Conflict("x");
        moveUser.mockRejectedValue(failure);
        vi.spyOn(repository, "delete").mockRejectedValue(new Error("delete failed"));

        await expect(
          service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID)
        ).rejects.toBe(failure);
        expect(mockLogError).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ organizationId: expect.any(Number), ownerUserId: OWNER_ID })
        );
      });
    });

    describe("owner by email", () => {
      const input = { name: "Acme", slug: "acme", domain: "acme.com" };
      const INVITE_EMAIL = "new.owner@acme.com";

      it("moves an existing user matched case-insensitively in as OWNER", async () => {
        membershipRepo.seedUser({
          id: OWNER_ID,
          username: "owner",
          email: "owner@acme.com",
          organizationId: OWNER_HOME_ORG_ID,
        });

        const created = await service.create(
          { ...input, owner: { email: "  Owner@ACME.com " }, confirmMoveOwner: true },
          ACTOR_ID
        );

        expect(moveUser).toHaveBeenCalledWith(
          { userId: OWNER_ID, toOrganizationId: created.id, role: "OWNER" },
          ACTOR_ID
        );
        expect(createInvitedWithPendingTeamMembership).not.toHaveBeenCalled();
        expect(mockLogInfo).toHaveBeenCalledWith(
          "organization.create",
          expect.objectContaining({ ownerUserId: OWNER_ID })
        );
      });

      it("invites an unknown email as a pending OWNER and logs no email", async () => {
        const created = await service.create(
          { ...input, owner: { email: " New.Owner@Acme.com " } },
          ACTOR_ID,
          "Admin Ann"
        );

        expect(repository.all()).toHaveLength(1);
        expect(createInvitedWithPendingTeamMembership).toHaveBeenCalledWith({
          email: INVITE_EMAIL,
          teamId: created.id,
          role: "OWNER",
          organizationId: created.id,
        });
        expect(sendInvite).toHaveBeenCalledWith(
          expect.objectContaining({
            teamId: created.id,
            email: INVITE_EMAIL,
            inviterName: "Admin Ann",
            isOrganization: true,
          })
        );
        expect(mockLogInfo).toHaveBeenCalledWith("organization.create", {
          action: "organization.create",
          actorUserId: ACTOR_ID,
          organizationId: created.id,
          invitedOwner: true,
        });
        expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain(INVITE_EMAIL);
      });

      it.each([
        ["null", null],
        ["blank", "   "],
      ])("names the organization as inviter when the actor name is %s", async (_label, actorName) => {
        await service.create({ ...input, owner: { email: INVITE_EMAIL } }, ACTOR_ID, actorName);

        expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ inviterName: "Acme" }));
      });

      it("deletes the organization and rethrows when the invite fails", async () => {
        const failure = new Error("smtp down");
        sendInvite.mockRejectedValue(failure);

        await expect(service.create({ ...input, owner: { email: INVITE_EMAIL } }, ACTOR_ID)).rejects.toBe(
          failure
        );
        expect(repository.all()).toEqual([]);
        expect(mockLogInfo).not.toHaveBeenCalledWith("organization.create", expect.anything());
      });

      it("rejects an existing user without a username and creates nothing", async () => {
        membershipRepo.seedUser({
          id: OWNER_ID,
          username: null,
          email: "owner@acme.com",
          organizationId: OWNER_HOME_ORG_ID,
        });

        await expectRejection(
          service.create({ ...input, owner: { email: "owner@acme.com" } }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "organization_owner_needs_username"
        );
        expect(repository.all()).toHaveLength(0);
      });

      it("rejects an email without an @ and creates nothing", async () => {
        await expectRejection(
          service.create({ ...input, owner: { email: "not-an-email" } }, ACTOR_ID),
          ErrorCode.BadRequest,
          "organization_owner_email_invalid"
        );
        expect(repository.all()).toHaveLength(0);
      });
    });

    it.each([
      ["empty", "   "],
      ["over 100 characters", "a".repeat(101)],
    ])("rejects a name that is %s", async (_label, name) => {
      await expectRejection(
        service.create(
          { name, slug: "acme", domain: "acme.com", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        ),
        ErrorCode.BadRequest,
        NAME_INVALID
      );
    });

    it("accepts a name of exactly 100 characters", async () => {
      const created = await service.create(
        { name: "a".repeat(100), slug: "acme", domain: "acme.com", owner: OWNER, confirmMoveOwner: true },
        ACTOR_ID
      );
      expect(created.name).toHaveLength(100);
    });

    describe("slug validation", () => {
      it.each([
        ["a single character", "a"],
        ["a leading hyphen", "-acme"],
        ["a trailing hyphen", "acme-"],
        ["64 characters", "a".repeat(64)],
        ["invalid characters", "acme_inc"],
        ["whitespace inside", "ac me"],
      ])("rejects a slug with %s", async (_label, slug) => {
        await expectRejection(
          service.create(
            { name: "Acme", slug, domain: "acme.com", owner: OWNER, confirmMoveOwner: true },
            ACTOR_ID
          ),
          ErrorCode.BadRequest,
          SLUG_INVALID
        );
      });

      it.each([
        ["two characters", "ab"],
        ["63 characters", "a".repeat(63)],
        ["an inner hyphen", "a-b"],
      ])("accepts a slug with %s", async (_label, slug) => {
        const created = await service.create(
          { name: "Acme", slug, domain: "acme.com", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        );
        expect(created.slug).toBe(slug);
      });

      it("lowercases an uppercase slug", async () => {
        const created = await service.create(
          { name: "Acme", slug: "ACME", domain: "acme.com", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        );
        expect(created.slug).toBe("acme");
      });
    });

    describe("domain validation", () => {
      it.each([
        ["an IPv4 address", "192.168.1.1"],
        ["an IPv6 address", "[::1]"],
        ["localhost", "localhost"],
        ["a scheme", "https://acme.com"],
        ["a path", "acme.com/path"],
        ["no TLD", "acme"],
        ["an empty value", "   "],
        ["a label starting with a hyphen", "-acme.com"],
      ])("rejects %s", async (_label, domain) => {
        await expectRejection(
          service.create(
            { name: "Acme", slug: "acme", domain, owner: OWNER, confirmMoveOwner: true },
            ACTOR_ID
          ),
          ErrorCode.BadRequest,
          DOMAIN_INVALID
        );
      });

      it("strips the port", async () => {
        const created = await service.create(
          { name: "Acme", slug: "acme", domain: "acme.com:8080", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        );
        expect(created.domain).toBe("acme.com");
      });

      it("normalizes uppercase and a trailing dot", async () => {
        const created = await service.create(
          { name: "Acme", slug: "acme", domain: " App.Acme.COM. ", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        );
        expect(created.domain).toBe("app.acme.com");
      });
    });

    it("rejects a slug that is already taken", async () => {
      repository.seed({ name: "Other", slug: "acme", domain: "other.com" });

      await expectRejection(
        service.create(
          { name: "Acme", slug: "ACME", domain: "acme.com", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        ),
        ErrorCode.Conflict,
        "organization_slug_taken"
      );
    });

    it("rejects a domain that is already taken", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "acme.com" });

      await expectRejection(
        service.create(
          { name: "Acme", slug: "acme", domain: "ACME.com:443", owner: OWNER, confirmMoveOwner: true },
          ACTOR_ID
        ),
        ErrorCode.Conflict,
        "organization_domain_taken"
      );
    });

    it("marks the organization on the default domain as default", async () => {
      const created = await service.create(
        { name: "Main", slug: "main", domain: DEFAULT_DOMAIN, owner: OWNER, confirmMoveOwner: true },
        ACTOR_ID
      );
      expect(created.isDefault).toBe(true);
    });
  });

  describe("get", () => {
    it("returns the organization with its owners", async () => {
      const owner = { userId: 7, name: "Owner", email: "owner@acme.com" };
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com", owners: [owner] });

      const organization = await service.get(seeded.id);

      expect(organization).toMatchObject({ id: seeded.id, owners: [owner], isDefault: false });
    });

    it("throws NotFound for an unknown id", async () => {
      await expectRejection(service.get(999), ErrorCode.NotFound, NOT_FOUND);
    });

    it("never marks an organization as default when no default domain is configured", async () => {
      service = buildService({ defaultDomain: null });
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });
      const withoutDomain = repository.seed({ name: "Bare", slug: "bare", domain: null });

      expect((await service.get(seeded.id)).isDefault).toBe(false);
      expect((await service.get(withoutDomain.id)).isDefault).toBe(false);
    });
  });

  describe("getForMember", () => {
    const VIEWER_ID = 50;

    it("returns the organization without counts and with the viewer's role", async () => {
      const owner = { userId: 7, name: "Owner", email: "owner@acme.com" };
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com", owners: [owner] });
      membershipRepo.seedMembership({ userId: VIEWER_ID, teamId: seeded.id, role: "ADMIN" });

      const organization = await service.getForMember({ organizationId: seeded.id, viewerUserId: VIEWER_ID });

      expect(organization).toEqual({
        id: seeded.id,
        name: "Acme",
        slug: "acme",
        domain: "acme.com",
        isDefault: false,
        logoUrl: null,
        owners: [owner],
        viewerRole: "ADMIN",
      });
    });

    it("marks the default organization", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });
      membershipRepo.seedMembership({ userId: VIEWER_ID, teamId: seeded.id, role: "MEMBER" });

      const organization = await service.getForMember({ organizationId: seeded.id, viewerUserId: VIEWER_ID });

      expect(organization).toMatchObject({ isDefault: true, viewerRole: "MEMBER" });
    });

    it("throws NotFound for a viewer who is not a member", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.getForMember({ organizationId: seeded.id, viewerUserId: VIEWER_ID }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });

    it("throws NotFound for a viewer whose invitation is still pending", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      membershipRepo.seedMembership({ userId: VIEWER_ID, teamId: seeded.id, role: "OWNER", accepted: false });

      await expectRejection(
        service.getForMember({ organizationId: seeded.id, viewerUserId: VIEWER_ID }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });

    it("throws NotFound when the organization no longer exists", async () => {
      membershipRepo.seedMembership({ userId: VIEWER_ID, teamId: 999, role: "OWNER" });

      await expectRejection(
        service.getForMember({ organizationId: 999, viewerUserId: VIEWER_ID }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });
  });

  describe("getDefault", () => {
    const DEFAULT_NOT_FOUND = "default_organization_not_found";

    it("returns the organization on the configured default domain", async () => {
      repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      const organization = await service.getDefault();

      expect(organization).toMatchObject({ id: seeded.id, domain: DEFAULT_DOMAIN, isDefault: true });
    });

    it("throws NotFound when no default domain is configured", async () => {
      service = buildService({ defaultDomain: null });
      const findDefault = vi.spyOn(repository, "findDefault");
      repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      await expectRejection(service.getDefault(), ErrorCode.NotFound, DEFAULT_NOT_FOUND);
      expect(findDefault).not.toHaveBeenCalled();
    });

    it("throws NotFound when no organization uses the default domain", async () => {
      repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(service.getDefault(), ErrorCode.NotFound, DEFAULT_NOT_FOUND);
    });
  });

  describe("ensureDefault", () => {
    it("returns the existing default organization without creating one", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });
      const create = vi.spyOn(repository, "create");

      const organization = await service.ensureDefault();

      expect(organization).toMatchObject({ id: seeded.id, name: "Main", isDefault: true });
      expect(create).not.toHaveBeenCalled();
      expect(repository.all()).toHaveLength(1);
    });

    it("creates the default organization on the default domain and logs it", async () => {
      const organization = await service.ensureDefault();

      expect(organization).toMatchObject({
        name: "Default",
        slug: "default",
        domain: DEFAULT_DOMAIN,
        isDefault: true,
      });
      expect(repository.all()).toHaveLength(1);
      expect(mockLogInfo).toHaveBeenCalledWith("organization.default.create", {
        action: "organization.default.create",
        organizationId: organization.id,
      });
    });

    it.each(["localhost", "localhost:3000"])("creates it on a %s default domain", async (domain) => {
      service = buildService({ defaultDomain: domain });

      const organization = await service.ensureDefault();

      expect(organization).toMatchObject({ slug: "default", domain, isDefault: true });
    });

    it("falls back to another slug when another organization holds 'default'", async () => {
      repository.seed({ name: "Other", slug: "default", domain: "other.com" });

      const organization = await service.ensureDefault();

      expect(organization).toMatchObject({ slug: "default-organization", domain: DEFAULT_DOMAIN });
    });

    it("returns the organization a concurrent request created when the insert conflicts", async () => {
      vi.spyOn(repository, "create").mockImplementationOnce(async () => {
        repository.seed({ name: "Default", slug: "default", domain: DEFAULT_DOMAIN });
        throw new Error("Unique constraint failed");
      });

      const organization = await service.ensureDefault();

      expect(organization).toMatchObject({ slug: "default", domain: DEFAULT_DOMAIN, isDefault: true });
      expect(repository.all()).toHaveLength(1);
    });

    it("rethrows a create failure when no default organization exists afterwards", async () => {
      vi.spyOn(repository, "create").mockRejectedValueOnce(new Error("database unavailable"));

      await expect(service.ensureDefault()).rejects.toThrow("database unavailable");
    });

    it("throws PreconditionFailed when no default domain is configured", async () => {
      service = buildService({ defaultDomain: null });
      const create = vi.spyOn(repository, "create");

      await expectRejection(
        service.ensureDefault(),
        ErrorCode.PreconditionFailed,
        "default_organization_requires_webapp_host"
      );
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("updates only the provided fields", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const updated = await service.update(seeded.id, { name: " Acme Corp " }, ACTOR_ID);

      expect(updated).toMatchObject({ name: "Acme Corp", slug: "acme", domain: "acme.com" });
      expect(mockLogInfo).toHaveBeenCalledWith("organization.update", {
        action: "organization.update",
        actorUserId: ACTOR_ID,
        organizationId: seeded.id,
        changed: ["name"],
      });
    });

    it("allows keeping its own slug and domain", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const updated = await service.update(seeded.id, { slug: "ACME", domain: "acme.com:443" }, ACTOR_ID);

      expect(updated).toMatchObject({ slug: "acme", domain: "acme.com" });
    });

    it("rejects a slug taken by another organization", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "other.com" });
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.update(seeded.id, { slug: "other" }, ACTOR_ID),
        ErrorCode.Conflict,
        "organization_slug_taken"
      );
    });

    it("rejects a domain taken by another organization", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "other.com" });
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.update(seeded.id, { domain: "Other.com" }, ACTOR_ID),
        ErrorCode.Conflict,
        "organization_domain_taken"
      );
    });

    it("validates provided fields", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.update(seeded.id, { name: "" }, ACTOR_ID),
        ErrorCode.BadRequest,
        NAME_INVALID
      );
      await expectRejection(
        service.update(seeded.id, { slug: "a" }, ACTOR_ID),
        ErrorCode.BadRequest,
        SLUG_INVALID
      );
      await expectRejection(
        service.update(seeded.id, { domain: "localhost" }, ACTOR_ID),
        ErrorCode.BadRequest,
        DOMAIN_INVALID
      );
    });

    it("throws NotFound for an unknown id", async () => {
      await expectRejection(service.update(999, { name: "Acme" }, ACTOR_ID), ErrorCode.NotFound, NOT_FOUND);
    });

    it("refuses to move the default organization off the default domain", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      await expectRejection(
        service.update(seeded.id, { domain: "elsewhere.com" }, ACTOR_ID),
        ErrorCode.PreconditionFailed,
        "organization_default_domain_locked"
      );
      expect((await repository.findById(seeded.id))?.domain).toBe(DEFAULT_DOMAIN);
    });

    it("lets the default organization keep its domain and change other fields", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      const updated = await service.update(
        seeded.id,
        {
          name: "Main Org",
          slug: "main-org",
          domain: DEFAULT_DOMAIN.toUpperCase(),
        },
        ACTOR_ID
      );

      expect(updated).toMatchObject({ name: "Main Org", slug: "main-org", isDefault: true });
    });

    it("lets a non-default organization take the default domain once it is free", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const updated = await service.update(seeded.id, { domain: DEFAULT_DOMAIN }, ACTOR_ID);

      expect(updated.isDefault).toBe(true);
    });

    describe("ownerUserId", () => {
      const NEW_OWNER_ID = 2;
      const EXISTING_OWNER_ID = 3;
      let organizationId: number;

      beforeEach(() => {
        organizationId = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" }).id;
        membershipRepo.seedUser({ id: EXISTING_OWNER_ID, username: "boss", organizationId });
        membershipRepo.seedMembership({ userId: EXISTING_OWNER_ID, teamId: organizationId, role: "OWNER" });
        // The fake keeps owners as static data, so derive them from memberships the way the real query does
        const findById = repository.findById.bind(repository);
        vi.spyOn(repository, "findById").mockImplementation(async (id) => {
          const record = await findById(id);
          if (!record) return null;
          const owners = membershipRepo.memberships
            .filter((m) => m.teamId === id && m.role === "OWNER" && m.accepted)
            .map((m) => {
              const user = membershipRepo.users.find((u) => u.id === m.userId);
              return { userId: m.userId, name: user?.name ?? null, email: user?.email ?? "" };
            });
          return { ...record, owners };
        });
      });

      function roleOf(userId: number) {
        return membershipRepo.memberships.find((m) => m.userId === userId && m.teamId === organizationId);
      }

      it("promotes an accepted member, keeps other owners and returns the fresh owner list", async () => {
        membershipRepo.seedUser({ id: NEW_OWNER_ID, username: "new", organizationId });
        membershipRepo.seedMembership({ userId: NEW_OWNER_ID, teamId: organizationId, role: "MEMBER" });

        const updated = await service.update(organizationId, { ownerUserId: NEW_OWNER_ID }, ACTOR_ID);

        expect(roleOf(NEW_OWNER_ID)).toMatchObject({ role: "OWNER", accepted: true });
        expect(roleOf(EXISTING_OWNER_ID)).toMatchObject({ role: "OWNER", accepted: true });
        expect(updated.owners.map((owner) => owner.userId)).toEqual([EXISTING_OWNER_ID, NEW_OWNER_ID]);
        expect(mockLogInfo).toHaveBeenCalledWith("organization.update", {
          action: "organization.update",
          actorUserId: ACTOR_ID,
          organizationId,
          changed: ["owner"],
          ownerUserId: NEW_OWNER_ID,
        });
      });

      it("accepts a user who is already an owner", async () => {
        const updated = await service.update(organizationId, { ownerUserId: EXISTING_OWNER_ID }, ACTOR_ID);

        expect(roleOf(EXISTING_OWNER_ID)).toMatchObject({ role: "OWNER" });
        expect(updated.owners.map((owner) => owner.userId)).toEqual([EXISTING_OWNER_ID]);
      });

      it("adds a user of the organization without a membership as OWNER", async () => {
        membershipRepo.seedUser({ id: NEW_OWNER_ID, username: "new", organizationId });

        await service.update(organizationId, { ownerUserId: NEW_OWNER_ID }, ACTOR_ID);

        expect(roleOf(NEW_OWNER_ID)).toMatchObject({ role: "OWNER", accepted: true });
        expect(membershipRepo.users.find((u) => u.id === NEW_OWNER_ID)?.organizationId).toBe(organizationId);
      });

      it("turns a pending member into an accepted OWNER", async () => {
        membershipRepo.seedUser({ id: NEW_OWNER_ID, username: "new", organizationId });
        membershipRepo.seedMembership({
          userId: NEW_OWNER_ID,
          teamId: organizationId,
          role: "MEMBER",
          accepted: false,
        });

        await service.update(organizationId, { ownerUserId: NEW_OWNER_ID }, ACTOR_ID);

        expect(roleOf(NEW_OWNER_ID)).toMatchObject({ role: "OWNER", accepted: true });
      });

      it("rejects a user without a username and leaves the other fields unchanged", async () => {
        membershipRepo.seedUser({ id: NEW_OWNER_ID, username: null, organizationId });

        await expectRejection(
          service.update(organizationId, { name: "Renamed", ownerUserId: NEW_OWNER_ID }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "organization_owner_needs_username"
        );
        expect((await repository.findById(organizationId))?.name).toBe("Acme");
      });

      it("rejects a user from another organization without moving them", async () => {
        const other = repository.seed({ name: "Globex", slug: "globex", domain: "globex.com" });
        membershipRepo.seedUser({ id: NEW_OWNER_ID, username: "new", organizationId: other.id });

        await expectRejection(
          service.update(organizationId, { ownerUserId: NEW_OWNER_ID }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "owner_in_another_organization"
        );
        expect(moveUser).not.toHaveBeenCalled();
        expect(roleOf(NEW_OWNER_ID)).toBeUndefined();
      });
    });

    it("throws NotFound when the organization disappears before the write", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      repository.update = async () => null;

      await expectRejection(
        service.update(seeded.id, { name: "Gone" }, ACTOR_ID),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });
  });

  describe("updateName", () => {
    const ACTOR = 42;

    function seedOrgWith(actorRole: "OWNER" | "ADMIN" | "MEMBER") {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      membershipRepo.seedMembership({ userId: ACTOR, teamId: seeded.id, role: actorRole });
      return seeded;
    }

    it("renames the organization for an OWNER and trims the name", async () => {
      const seeded = seedOrgWith("OWNER");

      const renamed = await service.updateName({
        organizationId: seeded.id,
        actorUserId: ACTOR,
        name: "  Acme Inc  ",
      });

      expect(renamed).toMatchObject({ id: seeded.id, name: "Acme Inc", slug: "acme" });
      expect((await repository.findById(seeded.id))?.name).toBe("Acme Inc");
    });

    it("renames the organization for an ADMIN", async () => {
      const seeded = seedOrgWith("ADMIN");

      const renamed = await service.updateName({
        organizationId: seeded.id,
        actorUserId: ACTOR,
        name: "Acme Inc",
      });

      expect(renamed.name).toBe("Acme Inc");
    });

    it("leaves slug and domain untouched", async () => {
      const seeded = seedOrgWith("OWNER");

      await service.updateName({ organizationId: seeded.id, actorUserId: ACTOR, name: "Renamed" });

      expect(await repository.findById(seeded.id)).toMatchObject({
        name: "Renamed",
        slug: "acme",
        domain: "acme.com",
      });
    });

    it("throws Forbidden for an accepted MEMBER", async () => {
      const seeded = seedOrgWith("MEMBER");

      await expectRejection(
        service.updateName({ organizationId: seeded.id, actorUserId: ACTOR, name: "Renamed" }),
        ErrorCode.Forbidden,
        "organization_only_managers_can_update_organization"
      );
      expect((await repository.findById(seeded.id))?.name).toBe("Acme");
    });

    it("throws NotFound for a viewer who is not a member", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.updateName({ organizationId: seeded.id, actorUserId: ACTOR, name: "Renamed" }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });

    it("throws NotFound for a viewer whose invitation is still pending", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      membershipRepo.seedMembership({ userId: ACTOR, teamId: seeded.id, role: "OWNER", accepted: false });

      await expectRejection(
        service.updateName({ organizationId: seeded.id, actorUserId: ACTOR, name: "Renamed" }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });

    it.each(["", "   ", "a".repeat(101)])("throws BadRequest for an invalid name %j", async (name) => {
      const seeded = seedOrgWith("OWNER");

      await expectRejection(
        service.updateName({ organizationId: seeded.id, actorUserId: ACTOR, name }),
        ErrorCode.BadRequest,
        NAME_INVALID
      );
      expect((await repository.findById(seeded.id))?.name).toBe("Acme");
    });

    it("throws NotFound when the organization disappears before the write", async () => {
      const seeded = seedOrgWith("OWNER");
      repository.update = async () => null;

      await expectRejection(
        service.updateName({ organizationId: seeded.id, actorUserId: ACTOR, name: "Gone" }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });
  });

  describe("updateLogo", () => {
    const ACTOR = 42;
    const LOGO = "data:image/png;base64,AAAA";

    function seedOrgWith(actorRole: "OWNER" | "ADMIN" | "MEMBER") {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      membershipRepo.seedMembership({ userId: ACTOR, teamId: seeded.id, role: actorRole });
      return seeded;
    }

    it.each(["OWNER", "ADMIN"] as const)("uploads and stores the logo for an %s", async (role) => {
      const seeded = seedOrgWith(role);

      const updated = await service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo: LOGO });

      expect(uploadLogo).toHaveBeenCalledWith({ teamId: seeded.id, logo: LOGO });
      expect(updated.logoUrl).toBe("/api/avatar/logo.png");
      expect((await repository.findById(seeded.id))?.logoUrl).toBe("/api/avatar/logo.png");
    });

    it("removes the logo without uploading when logo is null", async () => {
      const seeded = seedOrgWith("OWNER");
      await service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo: LOGO });

      const updated = await service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo: null });

      expect(uploadLogo).toHaveBeenCalledTimes(1);
      expect(updated.logoUrl).toBeNull();
      expect((await repository.findById(seeded.id))?.logoUrl).toBeNull();
    });

    it.each([
      "",
      "https://example.com/logo.png",
      "data:text/html;base64,AAAA",
    ])("throws BadRequest for an invalid logo %j", async (logo) => {
      const seeded = seedOrgWith("OWNER");

      await expectRejection(
        service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo }),
        ErrorCode.BadRequest,
        "organization_logo_invalid"
      );
      expect(uploadLogo).not.toHaveBeenCalled();
    });

    it("throws Forbidden for an accepted MEMBER", async () => {
      const seeded = seedOrgWith("MEMBER");

      await expectRejection(
        service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo: LOGO }),
        ErrorCode.Forbidden,
        "organization_only_managers_can_update_organization"
      );
      expect(uploadLogo).not.toHaveBeenCalled();
    });

    it("throws NotFound for a viewer who is not a member", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo: LOGO }),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });

    it("logs the actor and organization", async () => {
      const seeded = seedOrgWith("OWNER");

      await service.updateLogo({ organizationId: seeded.id, actorUserId: ACTOR, logo: null });

      expect(mockLogInfo).toHaveBeenCalledWith("organization.updateLogo", {
        action: "organization.updateLogo",
        actorUserId: ACTOR,
        organizationId: seeded.id,
      });
    });
  });

  describe("demoteOwner", () => {
    it("demotes the owner through the membership service and returns the organization", async () => {
      const { id } = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      membershipRepo.seedUser({ id: 2, organizationId: id });
      membershipRepo.seedMembership({ userId: OWNER_ID, teamId: id, role: "OWNER" });
      membershipRepo.seedMembership({ userId: 2, teamId: id, role: "OWNER" });

      const result = await service.demoteOwner(id, { userId: 2, role: "ADMIN" }, ACTOR_ID);

      expect(result.id).toBe(id);
      expect(await membershipRepo.findMembership({ organizationId: id, userId: 2 })).toEqual({
        role: "ADMIN",
        accepted: true,
      });
      expect(mockLogInfo).toHaveBeenCalledWith(
        "organization.owner.demote",
        expect.objectContaining({ actorUserId: ACTOR_ID, organizationId: id, userId: 2 })
      );
    });

    it("throws NotFound for an unknown organization", async () => {
      await expectRejection(
        service.demoteOwner(999, { userId: 2, role: "ADMIN" }, ACTOR_ID),
        ErrorCode.NotFound,
        NOT_FOUND
      );
    });
  });

  describe("delete", () => {
    it("deletes an empty organization", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expect(service.delete(seeded.id, ACTOR_ID)).resolves.toEqual({ id: seeded.id });
      expect(repository.all()).toHaveLength(0);
      expect(mockLogInfo).toHaveBeenCalledWith("organization.delete", {
        action: "organization.delete",
        actorUserId: ACTOR_ID,
        organizationId: seeded.id,
      });
    });

    it("throws NotFound for an unknown id", async () => {
      await expectRejection(service.delete(999, ACTOR_ID), ErrorCode.NotFound, NOT_FOUND);
    });

    it("refuses to delete the default organization", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      await expectRejection(
        service.delete(seeded.id, ACTOR_ID),
        ErrorCode.PreconditionFailed,
        "organization_default_cannot_be_deleted"
      );
      expect(repository.all()).toHaveLength(1);
    });

    it.each([
      ["members", { memberCount: 1, teamCount: 0 }],
      ["teams", { memberCount: 0, teamCount: 2 }],
    ])("refuses to delete an organization that still has %s", async (_label, counts) => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com", ...counts });

      await expectRejection(
        service.delete(seeded.id, ACTOR_ID),
        ErrorCode.PreconditionFailed,
        "organization_delete_not_empty"
      );
      expect(repository.all()).toHaveLength(1);
    });

    it("throws NotFound when the organization disappears before the delete", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      repository.delete = async () => null;

      await expectRejection(service.delete(seeded.id, ACTOR_ID), ErrorCode.NotFound, NOT_FOUND);
    });
  });

  describe("list", () => {
    function seedMany(count: number): void {
      for (let index = 1; index <= count; index++) {
        repository.seed({ name: `Org ${index}`, slug: `org-${index}`, domain: `org-${index}.com` });
      }
    }

    it("defaults to 50 items and returns a cursor", async () => {
      seedMany(60);

      const result = await service.list({});

      expect(result.items).toHaveLength(50);
      expect(result.nextCursor).toBe(result.items[49].id);
    });

    it("clamps the limit to 100", async () => {
      seedMany(120);

      const result = await service.list({ limit: 500 });

      expect(result.items).toHaveLength(100);
    });

    it("clamps the limit to at least 1", async () => {
      seedMany(3);

      expect((await service.list({ limit: 0 })).items).toHaveLength(1);
      expect((await service.list({ limit: -5 })).items).toHaveLength(1);
    });

    it("pages with the cursor and passes the search through", async () => {
      seedMany(3);
      repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const firstPage = await service.list({ limit: 2 });
      const secondPage = await service.list({ limit: 2, cursor: firstPage.nextCursor });
      const searched = await service.list({ search: "acme" });

      expect(firstPage.items.map((item) => item.slug)).toEqual(["org-1", "org-2"]);
      expect(secondPage.items.map((item) => item.slug)).toEqual(["org-3", "acme"]);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(searched.items.map((item) => item.slug)).toEqual(["acme"]);
    });

    it("maps isDefault on list items", async () => {
      repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN, memberCount: 3, teamCount: 1 });
      repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const result = await service.list({});

      expect(result.items).toEqual([
        expect.objectContaining({ slug: "main", isDefault: true, memberCount: 3, teamCount: 1 }),
        expect.objectContaining({ slug: "acme", isDefault: false }),
      ]);
      expect(result.items[0]).not.toHaveProperty("owners");
    });

    it("maps no list item as default when no default domain is configured", async () => {
      service = buildService({ defaultDomain: null });
      repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      const result = await service.list({});

      expect(result.items[0].isDefault).toBe(false);
    });
  });
});
