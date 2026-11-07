import type { GetServerSidePropsContext } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServerSideProps } from "./getServerSideProps";

const findUniqueVerificationToken = vi.fn();
const findFirstUser = vi.fn();

vi.mock("@calcom/prisma", () => ({
  default: {
    verificationToken: { findUnique: (...args: unknown[]) => findUniqueVerificationToken(...args) },
    user: { findFirst: (...args: unknown[]) => findFirstUser(...args) },
  },
}));
vi.mock("@calcom/features/flags/features.repository", () => ({
  FeaturesRepository: class {
    checkIfFeatureIsEnabledGlobally() {
      return Promise.resolve(false);
    }
  },
}));
vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: vi.fn().mockResolvedValue(null),
}));
vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  IS_SELF_HOSTED: true,
  WEBAPP_URL: "http://localhost:3000",
}));
vi.mock("@server/lib/constants", () => ({ IS_GOOGLE_LOGIN_ENABLED: false }));

const bluebeeSubTeam = {
  metadata: null,
  isOrganization: false,
  parentId: 11,
  parent: { slug: "bluebee", isOrganization: true, organizationSettings: { orgAutoAcceptEmail: "" } },
  slug: "sales",
  organizationSettings: null,
};

function verificationTokenFor(identifier: string, team: Record<string, unknown>) {
  return {
    identifier,
    token: "invite-token",
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    team,
  };
}

const context = {
  query: { token: "invite-token" },
  req: { headers: {} },
} as unknown as GetServerSidePropsContext;

async function propsOf() {
  const result = await getServerSideProps(context);
  if (!("props" in result)) throw new Error("Expected props, got a redirect");
  return result.props;
}

describe("signup getServerSideProps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ORGANIZATIONS_ENABLED", "false");
    findFirstUser.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats an email invite to a BlueBee sub-team as a plain team invite with the flag off", async () => {
    findUniqueVerificationToken.mockResolvedValue(verificationTokenFor("john@acme.com", bluebeeSubTeam));

    const props = await propsOf();

    expect(props.orgSlug).toBeNull();
    expect(props.orgAutoAcceptEmail).toBeNull();
    expect(props.prepopulateFormValues).toEqual({ email: "john@acme.com", username: "john" });
  });

  it("does not treat an invite link to a BlueBee sub-team as an org invite with the flag off", async () => {
    findUniqueVerificationToken.mockResolvedValue(verificationTokenFor("invite-link-id", bluebeeSubTeam));

    const props = await propsOf();

    expect(props.orgSlug).toBeNull();
    expect(props.orgAutoAcceptEmail).toBeNull();
    expect(props.prepopulateFormValues).toBeNull();
  });

  it("keeps the parent organization for a sub-team invite with the flag on", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
    findUniqueVerificationToken.mockResolvedValue(verificationTokenFor("john@acme.com", bluebeeSubTeam));

    const props = await propsOf();

    expect(props.orgSlug).toBe("bluebee");
    expect(props.prepopulateFormValues).toEqual({ email: "john@acme.com", username: "john-acme" });
  });

  it("still treats an organization invite as an org invite with the flag off", async () => {
    findUniqueVerificationToken.mockResolvedValue(
      verificationTokenFor("john@acme.com", {
        ...bluebeeSubTeam,
        isOrganization: true,
        parentId: null,
        parent: null,
        slug: "bluebee",
      })
    );

    const props = await propsOf();

    expect(props.orgSlug).toBe("bluebee");
  });
});
