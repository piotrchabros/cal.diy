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

const SLUG_INVALID =
  "Organization slug must be 2-63 lowercase letters, digits or hyphens and cannot start or end with a hyphen";
const DOMAIN_INVALID = "Organization domain must be a valid hostname such as acme.com";
const NAME_INVALID = "Organization name must be between 1 and 100 characters";
const NOT_FOUND = "Organization not found";

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

  function buildService(
    config: OrganizationsConfig = { defaultDomain: DEFAULT_DOMAIN }
  ): OrganizationService {
    return new OrganizationService({
      organizationRepository: repository,
      organizationsConfig: config,
      organizationMembershipService: new OrganizationMembershipService({
        organizationMembershipRepository: membershipRepo,
        organizationRepository: repository,
      }),
    });
  }

  function ownerUser() {
    return membershipRepo.users.find((user) => user.id === OWNER_ID);
  }

  beforeEach(() => {
    mockLogInfo.mockClear();
    mockLogError.mockClear();
    repository = new InMemoryOrganizationRepository();
    membershipRepo = new InMemoryOrganizationMembershipRepository();
    membershipRepo.seedUser({ id: OWNER_ID, username: "owner" });
    service = buildService();
  });

  describe("create", () => {
    it("creates an organization with trimmed name, normalized slug and domain", async () => {
      const created = await service.create(
        { name: "  Acme  ", slug: " ACME-Inc ", domain: "Acme.COM:3000", owner: OWNER },
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

      it("adds the owner as an OWNER member with an org profile and logs ids only", async () => {
        const created = await service.create({ ...input, owner: OWNER }, ACTOR_ID);

        expect(ownerUser()?.organizationId).toBe(created.id);
        expect(membershipRepo.memberships).toEqual([
          { userId: OWNER_ID, teamId: created.id, role: "OWNER", accepted: true },
        ]);
        expect(membershipRepo.profiles).toEqual([
          { userId: OWNER_ID, organizationId: created.id, username: "owner" },
        ]);
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
          "Owner user not found"
        );
        expect(repository.all()).toHaveLength(0);
        expect(mockLogInfo).not.toHaveBeenCalled();
      });

      it("asks for confirmation when the owner belongs to another organization", async () => {
        const other = repository.seed({ name: "Globex", slug: "globex", domain: "globex.com" });
        membershipRepo.seedUser({ id: OWNER_ID, username: "owner", organizationId: other.id });

        await expectRejection(
          service.create({ ...input, owner: OWNER }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "The owner belongs to another organization; confirm to move them"
        );
        expect(repository.all()).toHaveLength(1);
        expect(ownerUser()?.organizationId).toBe(other.id);
      });

      it("refuses to move a confirmed owner from another organization for now", async () => {
        const other = repository.seed({ name: "Globex", slug: "globex", domain: "globex.com" });
        membershipRepo.seedUser({ id: OWNER_ID, username: "owner", organizationId: other.id });

        await expectRejection(
          service.create({ ...input, owner: OWNER, confirmMoveOwner: true }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "Moving an owner from another organization is not available yet"
        );
        expect(repository.all()).toHaveLength(1);
        expect(ownerUser()?.organizationId).toBe(other.id);
      });

      it("rejects an owner without a username", async () => {
        membershipRepo.seedUser({ id: OWNER_ID, username: null });

        await expectRejection(
          service.create({ ...input, owner: OWNER }, ACTOR_ID),
          ErrorCode.PreconditionFailed,
          "The owner needs a username before joining an organization"
        );
        expect(repository.all()).toHaveLength(0);
      });

      it.each([
        ["slug", { slug: "acme", domain: "other.com" }, "Organization slug is already taken"],
        ["domain", { slug: "other", domain: "acme.com" }, "Organization domain is already taken"],
      ])("leaves the owner untouched on a %s conflict", async (_label, taken, message) => {
        repository.seed({ name: "Other", ...taken });

        await expectRejection(
          service.create({ ...input, owner: OWNER }, ACTOR_ID),
          ErrorCode.Conflict,
          message
        );
        expect(ownerUser()?.organizationId).toBeNull();
        expect(membershipRepo.memberships).toEqual([]);
        expect(membershipRepo.profiles).toEqual([]);
      });

      it("deletes the organization and rethrows when adding the owner fails", async () => {
        const failure = ErrorWithCode.Factory.Conflict("x");
        vi.spyOn(membershipRepo, "addMember").mockRejectedValue(failure);

        await expect(service.create({ ...input, owner: OWNER }, ACTOR_ID)).rejects.toBe(failure);
        expect(repository.all()).toEqual([]);
        expect(mockLogInfo).not.toHaveBeenCalled();
      });

      it("surfaces the original error when the compensating delete also fails", async () => {
        const failure = ErrorWithCode.Factory.Conflict("x");
        vi.spyOn(membershipRepo, "addMember").mockRejectedValue(failure);
        vi.spyOn(repository, "delete").mockRejectedValue(new Error("delete failed"));

        await expect(service.create({ ...input, owner: OWNER }, ACTOR_ID)).rejects.toBe(failure);
        expect(mockLogError).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ organizationId: expect.any(Number), ownerUserId: OWNER_ID })
        );
      });
    });

    it.each([
      ["empty", "   "],
      ["over 100 characters", "a".repeat(101)],
    ])("rejects a name that is %s", async (_label, name) => {
      await expectRejection(
        service.create({ name, slug: "acme", domain: "acme.com", owner: OWNER }, ACTOR_ID),
        ErrorCode.BadRequest,
        NAME_INVALID
      );
    });

    it("accepts a name of exactly 100 characters", async () => {
      const created = await service.create(
        { name: "a".repeat(100), slug: "acme", domain: "acme.com", owner: OWNER },
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
          service.create({ name: "Acme", slug, domain: "acme.com", owner: OWNER }, ACTOR_ID),
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
          { name: "Acme", slug, domain: "acme.com", owner: OWNER },
          ACTOR_ID
        );
        expect(created.slug).toBe(slug);
      });

      it("lowercases an uppercase slug", async () => {
        const created = await service.create(
          { name: "Acme", slug: "ACME", domain: "acme.com", owner: OWNER },
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
          service.create({ name: "Acme", slug: "acme", domain, owner: OWNER }, ACTOR_ID),
          ErrorCode.BadRequest,
          DOMAIN_INVALID
        );
      });

      it("strips the port", async () => {
        const created = await service.create(
          { name: "Acme", slug: "acme", domain: "acme.com:8080", owner: OWNER },
          ACTOR_ID
        );
        expect(created.domain).toBe("acme.com");
      });

      it("normalizes uppercase and a trailing dot", async () => {
        const created = await service.create(
          { name: "Acme", slug: "acme", domain: " App.Acme.COM. ", owner: OWNER },
          ACTOR_ID
        );
        expect(created.domain).toBe("app.acme.com");
      });
    });

    it("rejects a slug that is already taken", async () => {
      repository.seed({ name: "Other", slug: "acme", domain: "other.com" });

      await expectRejection(
        service.create({ name: "Acme", slug: "ACME", domain: "acme.com", owner: OWNER }, ACTOR_ID),
        ErrorCode.Conflict,
        "Organization slug is already taken"
      );
    });

    it("rejects a domain that is already taken", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "acme.com" });

      await expectRejection(
        service.create({ name: "Acme", slug: "acme", domain: "ACME.com:443", owner: OWNER }, ACTOR_ID),
        ErrorCode.Conflict,
        "Organization domain is already taken"
      );
    });

    it("marks the organization on the default domain as default", async () => {
      const created = await service.create(
        { name: "Main", slug: "main", domain: DEFAULT_DOMAIN, owner: OWNER },
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
    const DEFAULT_NOT_FOUND = "Default organization not found";

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
        "Organization slug is already taken"
      );
    });

    it("rejects a domain taken by another organization", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "other.com" });
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.update(seeded.id, { domain: "Other.com" }, ACTOR_ID),
        ErrorCode.Conflict,
        "Organization domain is already taken"
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
        "The default organization's domain cannot be changed"
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
        "The default organization cannot be deleted"
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
        "Move the organization's members and teams out before deleting it"
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
