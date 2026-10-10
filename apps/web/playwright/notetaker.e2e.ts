import process from "node:process";
import type { AppFlags } from "@calcom/features/flags/config";
import { BookingStatus, MembershipRole } from "@calcom/prisma/enums";
import type { BrowserContext, Locator, Page, Response } from "@playwright/test";
import { expect } from "@playwright/test";
import type { Fixtures } from "./lib/fixtures";
import { test } from "./lib/fixtures";
import { localize } from "./lib/localize";
import { bookTimeSlot, selectFirstAvailableTimeSlotNextMonth } from "./lib/testUtils";

const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const HOST_FLAGS: Array<keyof AppFlags> = ["bookings-v3", "notetaker"];
const DEFAULT_EVENT_TYPE_SLUG = "notetaker-default";
const READY_TIMEOUT_MS = 60_000;

type SeededAttendee = { name: string; email: string; timeZone: string };
type SeededBooking = { id: number; uid: string };
type SeededUser = Awaited<ReturnType<Fixtures["users"]["create"]>>;

async function enableBookingsV3(prisma: Fixtures["prisma"]): Promise<{ enabled: boolean } | null> {
  const existing = await prisma.feature.findUnique({
    where: { slug: "bookings-v3" },
    select: { enabled: true },
  });
  await prisma.feature.upsert({
    where: { slug: "bookings-v3" },
    update: { enabled: true },
    create: { slug: "bookings-v3", enabled: true, type: "OPERATIONAL" },
  });
  return existing;
}

async function restoreBookingsV3(
  prisma: Fixtures["prisma"],
  existing: { enabled: boolean } | null
): Promise<void> {
  if (existing) {
    await prisma.feature.update({
      where: { slug: "bookings-v3" },
      data: { enabled: existing.enabled },
    });
    return;
  }
  await prisma.feature.deleteMany({ where: { slug: "bookings-v3" } });
}

function isNotetakerCall(response: Response, procedure: string): boolean {
  return new RegExp(`/api/trpc/.*notetaker[./][^?]*${procedure}`).test(response.url());
}

// The status is not asserted: the tRPC error conversion does not map ErrorWithCode to 403 here
async function expectAccessRefused(response: Response): Promise<void> {
  expect(response.ok()).toBe(false);
  expect(await response.text()).toContain("You do not have access to the notetaker results of this booking");
}

function isStateCallFor(response: Response, bookingUid: string): boolean {
  return isNotetakerCall(response, "getState") && response.url().includes(bookingUid);
}

async function seedDueBooking({
  users,
  bookings,
  attendees = [{ name: "Attendee Example", email: "attendee@example.com", timeZone: "Europe/London" }],
  host: existingHost,
  eventTypeId,
}: {
  users: Fixtures["users"];
  bookings: Fixtures["bookings"];
  attendees?: SeededAttendee[];
  host?: SeededUser;
  eventTypeId?: number;
}): Promise<{
  host: SeededUser;
  booking: Awaited<ReturnType<Fixtures["bookings"]["create"]>>;
}> {
  const host = existingHost ?? (await users.create({ userFeatureFlags: HOST_FLAGS }));
  // The start is inside the join lead time, so enabling dispatches the notetaker at once
  const booking = await bookings.create(host.id, host.username, eventTypeId ?? host.eventTypes[0].id, {
    title: "Notetaker E2E",
    status: BookingStatus.ACCEPTED,
    startTime: new Date(Date.now() + 60 * 1000),
    endTime: new Date(Date.now() + 31 * 60 * 1000),
    attendees: { createMany: { data: attendees } },
  });
  // The bookings fixture does not forward a location
  await bookings.update({ where: { id: booking.id }, data: { location: MEET_LINK } });
  return { host, booking };
}

async function setSharingMode(page: Page, eventTypeId: number, slug: "team" | "hosts_only"): Promise<void> {
  await page.goto(`/event-types/${eventTypeId}?tabName=advanced`);
  await expect(page.getByTestId("notetaker-event-type-sharing")).toBeVisible();
  const modeRadio = page.getByTestId(`notetaker-sharing-mode-${slug}`);
  await modeRadio.check();
  const saveButton = page.getByTestId("notetaker-sharing-save");
  const saveResponse = page.waitForResponse((response) => isNotetakerCall(response, "setEventTypeSharing"));
  await saveButton.click();
  expect((await saveResponse).status()).toBe(200);
  await expect(modeRadio).toBeChecked();
  // The save button is disabled once the draft is cleared
  await expect(saveButton).toBeDisabled();
  await expect(page.getByTestId("notetaker-sharing-set-by")).toBeVisible();
}

async function openBookingSheet(page: Page, bookingUid: string): Promise<Locator> {
  const bookingsGetResponse = page.waitForResponse((response) =>
    /\/api\/trpc\/bookings\/get.*/.test(response.url())
  );
  await page.goto("/bookings/upcoming", { waitUntil: "domcontentloaded" });
  await bookingsGetResponse;

  const bookingItem = page.locator(`[data-booking-uid="${bookingUid}"]`);
  await expect(bookingItem).toBeVisible();
  const firstButton = bookingItem.locator('[role="button"]').first();
  await firstButton.waitFor({ state: "visible" });
  const bookingDetailsResponse = page.waitForResponse((response) =>
    /\/api\/trpc\/bookings\/getBookingDetails/.test(response.url())
  );
  await firstButton.click();

  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("booking-sheet-title") });
  await expect(sheet).toBeVisible();
  expect((await bookingDetailsResponse).status()).toBe(200);
  // The section renders nothing while its getState query is pending
  await expect(sheet.getByTestId("notetaker-booking-section")).toBeVisible();
  return sheet;
}

async function runSweep(page: Page): Promise<void> {
  const response = await page.request.get("/api/cron/notetaker", {
    headers: { authorization: process.env.CRON_API_KEY ?? "" },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

async function waitForReady(prisma: Fixtures["prisma"], bookingId: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const session = await prisma.notetakerSession.findFirst({
          where: { bookingId },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        });
        return session?.status ?? null;
      },
      { timeout: READY_TIMEOUT_MS }
    )
    .toBe("READY");
  await expect
    .poll(
      async () => {
        const summary = await prisma.notetakerSummary.findFirst({
          where: { transcript: { bookingId } },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        });
        return summary?.status ?? null;
      },
      { timeout: READY_TIMEOUT_MS }
    )
    .toBe("READY");
}

async function enableAndFinish(
  page: Page,
  prisma: Fixtures["prisma"],
  booking: SeededBooking
): Promise<Locator> {
  const sheet = await openBookingSheet(page, booking.uid);
  const setEnabledResponse = page.waitForResponse((response) => isNotetakerCall(response, "setEnabled"));
  await sheet.getByTestId("notetaker-toggle").click();
  expect((await setEnabledResponse).status()).toBe(200);
  await runSweep(page);
  await waitForReady(prisma, booking.id);
  return sheet;
}

test.describe("Notetaker", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(process.env.NOTETAKER_BOT_PROVIDER !== "fake", "needs NOTETAKER_BOT_PROVIDER=fake");

  let previousBookingsV3: { enabled: boolean } | null = null;
  let bookingsV3Changed = false;

  test.beforeAll(async ({ prisma }) => {
    expect(
      process.env.CRON_API_KEY,
      "CRON_API_KEY must be set: the tests call GET /api/cron/notetaker"
    ).toBeTruthy();
    previousBookingsV3 = await enableBookingsV3(prisma);
    bookingsV3Changed = true;
  });

  test.afterAll(async ({ prisma }) => {
    // Without this guard a failed beforeAll would delete a flag row this file never touched
    if (!bookingsV3Changed) return;
    await restoreBookingsV3(prisma, previousBookingsV3);
  });

  test.afterEach(({ users }) => users.deleteAll());

  test("host enables the notetaker and reads transcript and summary", async ({
    page,
    users,
    bookings,
    prisma,
  }) => {
    const t = await localize("en");
    const { host, booking } = await seedDueBooking({ users, bookings });
    await host.apiLogin();

    const sheet = await enableAndFinish(page, prisma, booking);
    await expect(sheet.getByTestId("notetaker-status-badge")).toHaveText(t("notetaker_status_ready"));
    await expect(sheet.getByTestId("notetaker-view-transcript")).toBeVisible();

    await page.goto(`/booking/${booking.uid}/notetaker`);
    const passages = page.getByTestId("notetaker-passage");
    await expect(passages).toHaveCount(3);
    await expect(passages.nth(0)).toContainText("Alex Example");
    await expect(passages.nth(1)).toContainText("Sam Example");

    const summary = page.getByTestId("notetaker-summary");
    await expect(summary).toContainText(t("notetaker_summary_overview"));
    await expect(summary).toContainText(t("notetaker_summary_key_points"));
    await expect(summary).toContainText(t("notetaker_summary_decisions"));
    await expect(summary).toContainText(t("notetaker_summary_action_items"));
  });

  test("host shares and revokes attendee access", async ({ page, users, bookings, prisma, browser }) => {
    const attendee = await users.create();
    const outsider = await users.create();
    const { host, booking } = await seedDueBooking({
      users,
      bookings,
      attendees: [{ name: "Shared Attendee", email: attendee.email, timeZone: "Europe/London" }],
    });
    const resultsUrl = `/booking/${booking.uid}/notetaker`;
    await host.apiLogin();
    await enableAndFinish(page, prisma, booking);

    await page.goto(resultsUrl);
    await expect(page.getByTestId("notetaker-passage")).toHaveCount(3);
    await page.getByTestId("notetaker-share-toggle").click();
    await expect(page.getByTestId("notetaker-shared-status")).toBeVisible();

    const extraContexts: BrowserContext[] = [];
    try {
      const [attendeeContext, attendeePage] = await attendee.apiLoginOnNewBrowser(browser);
      extraContexts.push(attendeeContext);
      await attendeePage.goto(resultsUrl);
      await expect(attendeePage.getByTestId("notetaker-passage")).toHaveCount(3);
      await expect(attendeePage.getByTestId("notetaker-summary")).toBeVisible();

      const [outsiderContext, outsiderPage] = await outsider.apiLoginOnNewBrowser(browser);
      extraContexts.push(outsiderContext);
      const outsiderState = outsiderPage.waitForResponse((response) => isStateCallFor(response, booking.uid));
      await outsiderPage.goto(resultsUrl);
      await expectAccessRefused(await outsiderState);
      await expect(outsiderPage.getByTestId("notetaker-passage")).toHaveCount(0);

      await page.getByTestId("notetaker-share-toggle").click();
      await expect(page.getByTestId("notetaker-shared-status")).toHaveCount(0);

      const attendeeState = attendeePage.waitForResponse((response) => isStateCallFor(response, booking.uid));
      await attendeePage.reload();
      await expectAccessRefused(await attendeeState);
      await expect(attendeePage.getByTestId("notetaker-passage")).toHaveCount(0);
    } finally {
      await Promise.all(extraContexts.map((context) => context.close()));
    }
  });

  test("event-type default enables new bookings and discloses on the booking page", async ({
    page,
    users,
    prisma,
  }) => {
    const t = await localize("en");
    const host = await users.create({
      userFeatureFlags: HOST_FLAGS,
      eventTypes: [
        {
          title: "Notetaker default",
          slug: DEFAULT_EVENT_TYPE_SLUG,
          length: 30,
          locations: [{ type: "integrations:google:meet" }],
        },
      ],
    });
    const eventType = host.eventTypes.find((candidate) => candidate.slug === DEFAULT_EVENT_TYPE_SLUG);
    if (!eventType)
      throw new Error(`The users fixture did not create the ${DEFAULT_EVENT_TYPE_SLUG} event type`);
    await host.apiLogin();

    await page.goto(`/event-types/${eventType.id}?tabName=advanced`);
    const defaultToggle = page.getByTestId("notetaker-event-type-default");
    await expect(defaultToggle).not.toBeChecked();
    // The default is saved by its own mutation, not with the event type form
    const setDefaultResponse = page.waitForResponse((response) =>
      isNotetakerCall(response, "setEventTypeDefault")
    );
    await defaultToggle.click();
    expect((await setDefaultResponse).status()).toBe(200);
    await expect(defaultToggle).toBeChecked();

    await page.goto(`/${host.username}/${DEFAULT_EVENT_TYPE_SLUG}`);
    await selectFirstAvailableTimeSlotNextMonth(page);
    await expect(page.getByTestId("notetaker-disclosure")).toBeVisible();
    await bookTimeSlot(page);
    await expect(page.getByTestId("success-page")).toBeVisible();

    const newBooking = await prisma.booking.findFirst({
      where: { eventTypeId: eventType.id },
      orderBy: { createdAt: "desc" },
      select: { uid: true },
    });
    if (!newBooking) throw new Error("The booking made on the public page was not stored");

    const sheet = await openBookingSheet(page, newBooking.uid);
    await expect(sheet.getByTestId("notetaker-toggle")).toBeChecked();
    const [sourceText] = t("notetaker_enabled_by_event_type_default").split("{{date}}");
    await expect(sheet.getByTestId("notetaker-booking-section")).toContainText(sourceText.trim());
  });

  test("team sharing: a member reads from Shared with me, an outsider is refused, hosts only refuses the member", async ({
    page,
    users,
    bookings,
    prisma,
    browser,
  }) => {
    const admin = await users.create(
      { userFeatureFlags: HOST_FLAGS },
      { hasTeam: true, teamRole: MembershipRole.ADMIN }
    );
    // Not the teammates option: it would make the member a host instead of a shared viewer
    const member = await users.create();
    const outsider = await users.create();
    const { team } = await admin.getFirstTeamMembership();
    const teamEventType = await prisma.eventType.findFirstOrThrow({
      where: { teamId: team.id },
      select: { id: true },
    });
    await prisma.membership.create({
      data: {
        teamId: team.id,
        userId: member.id,
        role: MembershipRole.MEMBER,
        accepted: true,
        createdAt: new Date(),
      },
    });
    const { booking } = await seedDueBooking({ users, bookings, host: admin, eventTypeId: teamEventType.id });
    const resultsUrl = `/booking/${booking.uid}/notetaker`;
    await admin.apiLogin();

    // Sharing must be TEAM before the notetaker is enabled: the disclosure flag is fixed at dispatch
    await page.goto(`/event-types/${teamEventType.id}?tabName=advanced`);
    await expect(page.getByTestId("notetaker-event-type-sharing")).toBeVisible();
    await expect(page.getByTestId("notetaker-sharing-mode-hosts_only")).toBeChecked();
    await setSharingMode(page, teamEventType.id, "team");
    const settings = await prisma.eventTypeNotetakerSettings.findUnique({
      where: { eventTypeId: teamEventType.id },
      select: { sharingMode: true },
    });
    expect(settings?.sharingMode).toBe("TEAM");

    await enableAndFinish(page, prisma, booking);
    const session = await prisma.notetakerSession.findFirst({
      where: { bookingId: booking.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, colleagueSharingDisclosed: true },
    });
    expect(session).toEqual({ status: "READY", colleagueSharingDisclosed: true });

    await page.goto(resultsUrl);
    await expect(page.getByTestId("notetaker-passage")).toHaveCount(3);
    await expect(page.getByTestId("notetaker-access-summary")).toContainText(team.name);
    await expect(page.getByTestId("notetaker-share-toggle")).toBeVisible();
    await expect(page.getByTestId("notetaker-delete-button")).toBeVisible();

    const extraContexts: BrowserContext[] = [];
    try {
      const [memberContext, memberPage] = await member.apiLoginOnNewBrowser(browser);
      extraContexts.push(memberContext);
      await memberPage.goto("/bookings/upcoming");
      await memberPage.getByTestId("notetaker-shared-notes-link").click();
      await expect(memberPage).toHaveURL(/\/bookings\/shared-notes/);
      const sharedResults = memberPage.getByTestId("notetaker-shared-result");
      await expect(sharedResults).toHaveCount(1);
      await expect(sharedResults).toContainText("Notetaker E2E");
      await sharedResults.click();
      await expect(memberPage).toHaveURL(new RegExp(`/booking/${booking.uid}/notetaker`));
      await expect(memberPage.getByTestId("notetaker-passage")).toHaveCount(3);
      await expect(memberPage.getByTestId("notetaker-summary")).toBeVisible();
      await expect(memberPage.getByTestId("notetaker-shared-viewer-notice")).toBeVisible();
      const exportButton = memberPage.getByTestId("notetaker-export-button");
      await expect(exportButton).toBeVisible();
      await expect(exportButton).toBeEnabled();
      const exportResponse = memberPage.waitForResponse((response) => isNotetakerCall(response, "export"));
      await exportButton.click();
      expect((await exportResponse).status()).toBe(200);
      await expect(memberPage.getByTestId("notetaker-share-toggle")).toHaveCount(0);
      await expect(memberPage.getByTestId("notetaker-delete-button")).toHaveCount(0);
      await expect(memberPage.getByTestId("notetaker-access-summary")).toHaveCount(0);
      await expect(memberPage.getByTestId("notetaker-activity-list")).toHaveCount(0);

      const [outsiderContext, outsiderPage] = await outsider.apiLoginOnNewBrowser(browser);
      extraContexts.push(outsiderContext);
      const outsiderState = outsiderPage.waitForResponse((response) => isStateCallFor(response, booking.uid));
      await outsiderPage.goto(resultsUrl);
      await expectAccessRefused(await outsiderState);
      await expect(outsiderPage.getByTestId("notetaker-passage")).toHaveCount(0);
      const outsiderBookings = outsiderPage.waitForResponse((response) =>
        /\/api\/trpc\/bookings\/get.*/.test(response.url())
      );
      await outsiderPage.goto("/bookings/upcoming");
      await outsiderBookings;
      await expect(outsiderPage.getByTestId("notetaker-shared-notes-link")).toHaveCount(0);

      await setSharingMode(page, teamEventType.id, "hosts_only");

      const memberState = memberPage.waitForResponse((response) => isStateCallFor(response, booking.uid));
      await memberPage.reload();
      await expectAccessRefused(await memberState);
      await expect(memberPage.getByTestId("notetaker-passage")).toHaveCount(0);

      await page.goto(resultsUrl);
      await expect(page.getByTestId("notetaker-passage")).toHaveCount(3);
    } finally {
      await Promise.all(extraContexts.map((context) => context.close()));
    }
  });
});
