import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import type { OrganizationsConfig } from "./OrganizationService";
import { OrganizationService } from "./OrganizationService";

const DEFAULT_DOMAIN = "cal.example.com";

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
  let service: OrganizationService;

  function buildService(
    config: OrganizationsConfig = { defaultDomain: DEFAULT_DOMAIN }
  ): OrganizationService {
    return new OrganizationService({ organizationRepository: repository, organizationsConfig: config });
  }

  beforeEach(() => {
    repository = new InMemoryOrganizationRepository();
    service = buildService();
  });

  describe("create", () => {
    it("creates an organization with trimmed name, normalized slug and domain", async () => {
      const created = await service.create({ name: "  Acme  ", slug: " ACME-Inc ", domain: "Acme.COM:3000" });

      expect(created).toMatchObject({
        name: "Acme",
        slug: "acme-inc",
        domain: "acme.com",
        isDefault: false,
        memberCount: 0,
        teamCount: 0,
        owners: [],
      });
      expect(repository.all()).toHaveLength(1);
    });

    it.each([
      ["empty", "   "],
      ["over 100 characters", "a".repeat(101)],
    ])("rejects a name that is %s", async (_label, name) => {
      await expectRejection(
        service.create({ name, slug: "acme", domain: "acme.com" }),
        ErrorCode.BadRequest,
        NAME_INVALID
      );
    });

    it("accepts a name of exactly 100 characters", async () => {
      const created = await service.create({ name: "a".repeat(100), slug: "acme", domain: "acme.com" });
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
          service.create({ name: "Acme", slug, domain: "acme.com" }),
          ErrorCode.BadRequest,
          SLUG_INVALID
        );
      });

      it.each([
        ["two characters", "ab"],
        ["63 characters", "a".repeat(63)],
        ["an inner hyphen", "a-b"],
      ])("accepts a slug with %s", async (_label, slug) => {
        const created = await service.create({ name: "Acme", slug, domain: "acme.com" });
        expect(created.slug).toBe(slug);
      });

      it("lowercases an uppercase slug", async () => {
        const created = await service.create({ name: "Acme", slug: "ACME", domain: "acme.com" });
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
          service.create({ name: "Acme", slug: "acme", domain }),
          ErrorCode.BadRequest,
          DOMAIN_INVALID
        );
      });

      it("strips the port", async () => {
        const created = await service.create({ name: "Acme", slug: "acme", domain: "acme.com:8080" });
        expect(created.domain).toBe("acme.com");
      });

      it("normalizes uppercase and a trailing dot", async () => {
        const created = await service.create({ name: "Acme", slug: "acme", domain: " App.Acme.COM. " });
        expect(created.domain).toBe("app.acme.com");
      });
    });

    it("rejects a slug that is already taken", async () => {
      repository.seed({ name: "Other", slug: "acme", domain: "other.com" });

      await expectRejection(
        service.create({ name: "Acme", slug: "ACME", domain: "acme.com" }),
        ErrorCode.Conflict,
        "Organization slug is already taken"
      );
    });

    it("rejects a domain that is already taken", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "acme.com" });

      await expectRejection(
        service.create({ name: "Acme", slug: "acme", domain: "ACME.com:443" }),
        ErrorCode.Conflict,
        "Organization domain is already taken"
      );
    });

    it("marks the organization on the default domain as default", async () => {
      const created = await service.create({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });
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

  describe("update", () => {
    it("updates only the provided fields", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const updated = await service.update(seeded.id, { name: " Acme Corp " });

      expect(updated).toMatchObject({ name: "Acme Corp", slug: "acme", domain: "acme.com" });
    });

    it("allows keeping its own slug and domain", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const updated = await service.update(seeded.id, { slug: "ACME", domain: "acme.com:443" });

      expect(updated).toMatchObject({ slug: "acme", domain: "acme.com" });
    });

    it("rejects a slug taken by another organization", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "other.com" });
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.update(seeded.id, { slug: "other" }),
        ErrorCode.Conflict,
        "Organization slug is already taken"
      );
    });

    it("rejects a domain taken by another organization", async () => {
      repository.seed({ name: "Other", slug: "other", domain: "other.com" });
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(
        service.update(seeded.id, { domain: "Other.com" }),
        ErrorCode.Conflict,
        "Organization domain is already taken"
      );
    });

    it("validates provided fields", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expectRejection(service.update(seeded.id, { name: "" }), ErrorCode.BadRequest, NAME_INVALID);
      await expectRejection(service.update(seeded.id, { slug: "a" }), ErrorCode.BadRequest, SLUG_INVALID);
      await expectRejection(
        service.update(seeded.id, { domain: "localhost" }),
        ErrorCode.BadRequest,
        DOMAIN_INVALID
      );
    });

    it("throws NotFound for an unknown id", async () => {
      await expectRejection(service.update(999, { name: "Acme" }), ErrorCode.NotFound, NOT_FOUND);
    });

    it("refuses to move the default organization off the default domain", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      await expectRejection(
        service.update(seeded.id, { domain: "elsewhere.com" }),
        ErrorCode.PreconditionFailed,
        "The default organization's domain cannot be changed"
      );
      expect((await repository.findById(seeded.id))?.domain).toBe(DEFAULT_DOMAIN);
    });

    it("lets the default organization keep its domain and change other fields", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      const updated = await service.update(seeded.id, {
        name: "Main Org",
        slug: "main-org",
        domain: DEFAULT_DOMAIN.toUpperCase(),
      });

      expect(updated).toMatchObject({ name: "Main Org", slug: "main-org", isDefault: true });
    });

    it("lets a non-default organization take the default domain once it is free", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      const updated = await service.update(seeded.id, { domain: DEFAULT_DOMAIN });

      expect(updated.isDefault).toBe(true);
    });

    it("throws NotFound when the organization disappears before the write", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      repository.update = async () => null;

      await expectRejection(service.update(seeded.id, { name: "Gone" }), ErrorCode.NotFound, NOT_FOUND);
    });
  });

  describe("delete", () => {
    it("deletes an empty organization", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });

      await expect(service.delete(seeded.id)).resolves.toEqual({ id: seeded.id });
      expect(repository.all()).toHaveLength(0);
    });

    it("throws NotFound for an unknown id", async () => {
      await expectRejection(service.delete(999), ErrorCode.NotFound, NOT_FOUND);
    });

    it("refuses to delete the default organization", async () => {
      const seeded = repository.seed({ name: "Main", slug: "main", domain: DEFAULT_DOMAIN });

      await expectRejection(
        service.delete(seeded.id),
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
        service.delete(seeded.id),
        ErrorCode.PreconditionFailed,
        "Move the organization's members and teams out before deleting it"
      );
      expect(repository.all()).toHaveLength(1);
    });

    it("throws NotFound when the organization disappears before the delete", async () => {
      const seeded = repository.seed({ name: "Acme", slug: "acme", domain: "acme.com" });
      repository.delete = async () => null;

      await expectRejection(service.delete(seeded.id), ErrorCode.NotFound, NOT_FOUND);
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
