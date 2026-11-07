import { randomBytes } from "node:crypto";
import process from "node:process";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { prisma } from "@calcom/prisma";
import type { MembershipRole } from "@calcom/prisma/enums";
import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { v4 as uuidv4 } from "uuid";
import { hashPassword } from "./fixtures/users";
import { test } from "./lib/fixtures";

// specs/005-organizations quickstart S2, S4, S5 and S6. These need the multi-domain scratch setup from
// quickstart.md §2 (hosts entries for bluebee.test / bespoke.test / jelly.test, ORGANIZATIONS_ENABLED=1,
// a seeded scratch database with BlueBee on bluebee.test), so they skip everywhere else, including CI.
const webappUrl = new URL(WEBAPP_URL);
const PORT = webappUrl.port ? `:${webappUrl.port}` : "";
const BLUEBEE = `${webappUrl.protocol}//bluebee.test${PORT}`;
const BESPOKE = `${webappUrl.protocol}//bespoke.test${PORT}`;
const JELLY_DOMAIN = "jelly.test";
const BESPOKE_DOMAIN = "bespoke.test";
const TEST_EMAIL_DOMAINS = ["@bluebee.test", "@bespoke.test", "@jelly.test"];
const isScratchSetup = !!process.env.ORGANIZATIONS_ENABLED && webappUrl.hostname === "bluebee.test";

const ADMIN = { email: "admin@example.com", password: "ADMINadmin2022!" };
// 8 hex chars: the mailhog fixture only allows "to" searches that identify one test's emails
const suffix = randomBytes(4).toString("hex");
const PASSWORD = `Org-e2e-${suffix}-Pass1`;
const janUsername = `jan-${suffix}`;
const salesSlug = `sales-${suffix}`;
const ownerEmail = `owner-${suffix}@bespoke.test`;

test.describe.configure({ mode: "serial" });

async function cleanUpPreviousRuns() {
  const orgs = await prisma.team.findMany({
    where: { organizationSettings: { customDomain: { in: [BESPOKE_DOMAIN, JELLY_DOMAIN] } } },
    select: { id: true },
  });
  const orgIds = orgs.map((org) => org.id);
  await prisma.user.deleteMany({
    where: { OR: TEST_EMAIL_DOMAINS.map((domain) => ({ email: { endsWith: domain } })) },
  });
  await prisma.tempOrgRedirect.deleteMany({ where: { toUrl: { startsWith: BESPOKE } } });
  await prisma.team.deleteMany({
    where: { OR: [{ parentId: { in: orgIds } }, { slug: { startsWith: "sales-" } }] },
  });
  await prisma.team.deleteMany({ where: { id: { in: orgIds } } });
}

async function createOrgUser(opts: {
  username: string;
  email: string;
  organizationId: number;
  role?: MembershipRole;
}) {
  return prisma.user.create({
    data: {
      username: opts.username,
      name: opts.username,
      email: opts.email,
      emailVerified: new Date(),
      completedOnboarding: true,
      organizationId: opts.organizationId,
      password: { create: { hash: hashPassword(PASSWORD) } },
      profiles: {
        create: { uid: uuidv4(), username: opts.username, organizationId: opts.organizationId },
      },
      teams: { create: { teamId: opts.organizationId, accepted: true, role: opts.role ?? "MEMBER" } },
    },
    select: { id: true, email: true, username: true },
  });
}

async function findOrgIdByDomain(domain: string) {
  const org = await prisma.team.findFirst({
    where: { isOrganization: true, organizationSettings: { customDomain: domain } },
    select: { id: true },
  });
  if (!org) throw new Error(`No organization with domain ${domain} in the scratch database`);
  return org.id;
}

async function signIn(page: Page, origin: string, email: string, password: string) {
  await page.goto(`${origin}/auth/login`);
  const form = page.locator("[data-testid=login-form]");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(password);
  await form.locator('[type="submit"]').click();
}

async function newSignedInPage(browser: Browser, origin: string, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, origin, email, password);
  await expect(page).not.toHaveURL(/\/auth\/login/);
  return page;
}

async function pickOrganization(page: Page, search: string, optionName: RegExp) {
  await page.locator("#target-organization").fill(search);
  await page.getByRole("option", { name: optionName }).click();
}

test.describe("Organizations (quickstart S2, S4, S5, S6)", () => {
  test.skip(
    !isScratchSetup,
    "Needs the multi-domain scratch setup from specs/005-organizations/quickstart.md §2"
  );

  let bluebeeId: number;
  let jan: { id: number; email: string };
  let salesTeamId: number;
  let janBookingUid: string;

  test.beforeAll(async () => {
    await cleanUpPreviousRuns();
    bluebeeId = await findOrgIdByDomain("bluebee.test");
    jan = await createOrgUser({
      username: janUsername,
      email: `${janUsername}@bluebee.test`,
      organizationId: bluebeeId,
    });
    const sales = await prisma.team.create({
      data: {
        name: `Sales ${suffix}`,
        slug: salesSlug,
        parentId: bluebeeId,
        members: { create: { userId: jan.id, accepted: true, role: "OWNER" } },
      },
      select: { id: true },
    });
    salesTeamId = sales.id;
    janBookingUid = uuidv4();
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.booking.create({
      data: {
        uid: janBookingUid,
        title: `Org E2E booking ${suffix}`,
        startTime: start,
        endTime: new Date(start.getTime() + 30 * 60 * 1000),
        userId: jan.id,
      },
    });
  });

  test.afterAll(async () => {
    await cleanUpPreviousRuns();
  });

  test("S2: an instance admin creates BespokeSoft with an invited owner", async ({ browser, emails }) => {
    const page = await newSignedInPage(browser, BLUEBEE, ADMIN.email, ADMIN.password);
    await page.goto(`${BLUEBEE}/settings/admin/organizations/new`);

    await page.getByLabel("Name").fill("BespokeSoft");
    await page.getByLabel("Slug").fill("bespokesoft");
    await page.getByLabel("Domain").fill(BESPOKE_DOMAIN);
    await page.getByRole("radio", { name: "Invite by email" }).click();
    await page.getByLabel("Owner email").fill(ownerEmail);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("Organization created and the owner was invited")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/admin\/organizations$/);
    const bespokeId = await findOrgIdByDomain(BESPOKE_DOMAIN);
    const row = page.getByTestId(`organization-row-${bespokeId}`);
    await expect(row).toContainText("BespokeSoft");
    await expect(row).toContainText(BESPOKE_DOMAIN);

    const owner = await prisma.membership.findFirst({
      where: { teamId: bespokeId, user: { email: ownerEmail } },
      select: { role: true, accepted: true },
    });
    expect(owner).toEqual({ role: "OWNER", accepted: false });

    await expect
      .poll(
        async () => {
          const result = await emails.search(ownerEmail, "to");
          const message = result?.items?.[0];
          return message ? `${message.html ?? ""}${message.text ?? ""}` : "";
        },
        { timeout: 30_000 }
      )
      .toContain(`${BESPOKE}/auth/team-invite?token=`);
    await page.context().close();
  });

  test("S4: moving a user and a team to BespokeSoft moves their pages and keeps bookings", async ({
    browser,
  }) => {
    const page = await newSignedInPage(browser, BLUEBEE, ADMIN.email, ADMIN.password);

    await page.goto(`${BLUEBEE}/settings/admin/users/${jan.id}/edit`);
    await page.getByRole("button", { name: "Move to organization" }).click();
    await pickOrganization(page, "Bespoke", /BespokeSoft/);
    await page.getByRole("dialog").getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("User moved to the organization")).toBeVisible();

    await page.goto(`${BLUEBEE}/settings/admin/organizations/${bluebeeId}/edit`);
    const teamRow = page.getByTestId(`organization-team-row-${salesTeamId}`);
    await teamRow.getByRole("button", { name: "Move" }).click();
    await pickOrganization(page, "Bespoke", /BespokeSoft/);
    const moveButton = page.getByRole("dialog").getByRole("button", { name: "Move", exact: true });
    await expect(moveButton).toBeEnabled();
    await moveButton.click();
    await expect(page.getByText("Team moved to the organization")).toBeVisible();

    const userPage = await page.request.get(`${BESPOKE}/${janUsername}`);
    expect(userPage.status()).toBe(200);
    expect(await userPage.text()).toContain(janUsername);
    const teamPage = await page.request.get(`${BESPOKE}/team/${salesSlug}`);
    expect(teamPage.status()).toBe(200);

    const oldLink = await page.request.get(`${BLUEBEE}/${janUsername}`, { maxRedirects: 0 });
    expect([301, 308]).toContain(oldLink.status());
    expect(oldLink.headers().location).toBe(`${BESPOKE}/${janUsername}`);
    // The team page streams (it has a loading.tsx), so its redirect happens client-side after a 200
    // rather than as an HTTP 308 (follow-up T350); assert where a visitor actually ends up.
    await page.goto(`${BLUEBEE}/team/${salesSlug}`);
    await expect(page).toHaveURL(`${BESPOKE}/team/${salesSlug}`);

    const booking = await prisma.booking.findUnique({
      where: { uid: janBookingUid },
      select: { userId: true },
    });
    expect(booking?.userId).toBe(jan.id);
    await page.context().close();
  });

  test("S5: Jan signing in on bluebee.test is sent to bespoke.test and gets no bluebee session", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await signIn(page, BLUEBEE, jan.email, PASSWORD);
    await expect(page).toHaveURL(`${BESPOKE}/auth/login?reason=wrong_organization_domain`);

    await signIn(page, BESPOKE, jan.email, PASSWORD);
    await expect(page).not.toHaveURL(/\/auth\/login/);
    expect(new URL(page.url()).hostname).toBe(BESPOKE_DOMAIN);

    const bespokeSession = await (await context.request.get(`${BESPOKE}/api/auth/session`)).json();
    expect(bespokeSession?.user?.email).toBe(jan.email);
    const bluebeeSession = await (await context.request.get(`${BLUEBEE}/api/auth/session`)).json();
    expect(bluebeeSession?.user).toBeUndefined();
    await context.close();
  });

  test("S6: a BespokeSoft team admin cannot invite a JellyMatch member", async ({ browser }) => {
    const bespokeId = await findOrgIdByDomain(BESPOKE_DOMAIN);
    const jelly = await prisma.team.create({
      data: {
        name: "JellyMatch",
        slug: "jellymatch",
        isOrganization: true,
        organizationSettings: { create: { customDomain: JELLY_DOMAIN, orgAutoAcceptEmail: JELLY_DOMAIN } },
      },
      select: { id: true },
    });
    // Same username as the moved BespokeSoft Jan: usernames only need to be unique inside one organization
    const jellyJan = await createOrgUser({
      username: janUsername,
      email: `${janUsername}@jelly.test`,
      organizationId: jelly.id,
    });
    const teamAdmin = await createOrgUser({
      username: `team-admin-${suffix}`,
      email: `team-admin-${suffix}@bespoke.test`,
      organizationId: bespokeId,
    });
    const support = await prisma.team.create({
      data: {
        name: `Support ${suffix}`,
        slug: `support-${suffix}`,
        parentId: bespokeId,
        members: { create: { userId: teamAdmin.id, accepted: true, role: "ADMIN" } },
      },
      select: { id: true },
    });

    const page = await newSignedInPage(browser, BESPOKE, teamAdmin.email, PASSWORD);
    await page.goto(`${BESPOKE}/settings/my-teams/${support.id}/members`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    // TextField renders its label without a programmatic association here, so target the input itself
    await page.locator('input[type="email"]').fill(jellyJan.email);
    await page.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText("This person belongs to another organization")).toBeVisible();
    const membership = await prisma.membership.findFirst({
      where: { teamId: support.id, userId: jellyJan.id },
      select: { id: true },
    });
    expect(membership).toBeNull();
    await page.context().close();
  });
});
