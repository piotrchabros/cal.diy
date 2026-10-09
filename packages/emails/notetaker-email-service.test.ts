import type { TFunction } from "i18next";
import { createInstance } from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendNotetakerAdmitPromptEmail,
  sendNotetakerAttendeeNoticeEmail,
  sendNotetakerFailedEmail,
  sendNotetakerResultsReadyEmail,
  sendNotetakerSharedEmail,
  sendNotetakerTurnedOffEmail,
} from "./notetaker-email-service";
import type { NotetakerAttendeeNoticeEmailInput } from "./templates/attendee-notetaker-notice-email";
import type { NotetakerSharedEmailInput } from "./templates/attendee-notetaker-shared-email";
import type { NotetakerAdmitPromptEmailInput } from "./templates/organizer-notetaker-admit-prompt-email";
import type { NotetakerFailedEmailInput } from "./templates/organizer-notetaker-failed-email";
import type { NotetakerResultsReadyEmailInput } from "./templates/organizer-notetaker-results-ready-email";
import type { NotetakerTurnedOffEmailInput } from "./templates/organizer-notetaker-turned-off-email";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn<() => Promise<unknown>>(),
  constructed: [] as Array<{ template: string; input: unknown }>,
  constructorError: { current: null as Error | null },
}));

vi.mock("./templates/organizer-notetaker-results-ready-email", () => ({
  default: class OrganizerNotetakerResultsReadyEmail {
    constructor(input: unknown) {
      if (mocks.constructorError.current) throw mocks.constructorError.current;
      mocks.constructed.push({ template: "OrganizerNotetakerResultsReadyEmail", input });
    }
    sendEmail() {
      return mocks.sendEmail();
    }
  },
}));
vi.mock("./templates/attendee-notetaker-notice-email", () => ({
  default: class AttendeeNotetakerNoticeEmail {
    constructor(input: unknown) {
      if (mocks.constructorError.current) throw mocks.constructorError.current;
      mocks.constructed.push({ template: "AttendeeNotetakerNoticeEmail", input });
    }
    sendEmail() {
      return mocks.sendEmail();
    }
  },
}));
vi.mock("./templates/organizer-notetaker-admit-prompt-email", () => ({
  default: class OrganizerNotetakerAdmitPromptEmail {
    constructor(input: unknown) {
      if (mocks.constructorError.current) throw mocks.constructorError.current;
      mocks.constructed.push({ template: "OrganizerNotetakerAdmitPromptEmail", input });
    }
    sendEmail() {
      return mocks.sendEmail();
    }
  },
}));
vi.mock("./templates/organizer-notetaker-failed-email", () => ({
  default: class OrganizerNotetakerFailedEmail {
    constructor(input: unknown) {
      if (mocks.constructorError.current) throw mocks.constructorError.current;
      mocks.constructed.push({ template: "OrganizerNotetakerFailedEmail", input });
    }
    sendEmail() {
      return mocks.sendEmail();
    }
  },
}));
vi.mock("./templates/organizer-notetaker-turned-off-email", () => ({
  default: class OrganizerNotetakerTurnedOffEmail {
    constructor(input: unknown) {
      if (mocks.constructorError.current) throw mocks.constructorError.current;
      mocks.constructed.push({ template: "OrganizerNotetakerTurnedOffEmail", input });
    }
    sendEmail() {
      return mocks.sendEmail();
    }
  },
}));
vi.mock("./templates/attendee-notetaker-shared-email", () => ({
  default: class AttendeeNotetakerSharedEmail {
    constructor(input: unknown) {
      if (mocks.constructorError.current) throw mocks.constructorError.current;
      mocks.constructed.push({ template: "AttendeeNotetakerSharedEmail", input });
    }
    sendEmail() {
      return mocks.sendEmail();
    }
  },
}));

let t: TFunction;

beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    ns: ["common"],
    defaultNS: "common",
    resources: { en: { common: {} } },
  });
  t = i18n.getFixedT("en", "common");
});

const baseInput = () => ({
  t,
  locale: "en",
  timeZone: "UTC",
  to: { email: "host@example.com", name: "Host" },
  bookingTitle: "Weekly sync",
  bookingStartTime: new Date("2026-01-05T10:00:00.000Z"),
});

type SendCase = { input: object; promise: Promise<void> };

const resultsReady = (): SendCase => {
  const input: NotetakerResultsReadyEmailInput = {
    ...baseInput(),
    resultsUrl: "https://app.example.com/notetaker/1",
    sessionStatus: "READY",
    outcomeReason: null,
    transcriptCompleteness: "COMPLETE",
    summaryStatus: "READY",
  };
  return { input, promise: sendNotetakerResultsReadyEmail(input) };
};

const attendeeNotice = (): SendCase => {
  const input: NotetakerAttendeeNoticeEmailInput = {
    ...baseInput(),
    hostName: "Host",
    isPending: false,
  };
  return { input, promise: sendNotetakerAttendeeNoticeEmail(input) };
};

const admitPrompt = (): SendCase => {
  const input: NotetakerAdmitPromptEmailInput = {
    ...baseInput(),
    notetakerUrl: "https://app.example.com/notetaker/1",
  };
  return { input, promise: sendNotetakerAdmitPromptEmail(input) };
};

const failed = (overrides: Partial<NotetakerFailedEmailInput> = {}): SendCase => {
  const input: NotetakerFailedEmailInput = {
    ...baseInput(),
    notetakerUrl: "https://app.example.com/notetaker/1",
    outcomeReason: "NOT_ADMITTED",
    canEnableAgain: true,
    ...overrides,
  };
  return { input, promise: sendNotetakerFailedEmail(input) };
};

const turnedOff = (): SendCase => {
  const input: NotetakerTurnedOffEmailInput = {
    ...baseInput(),
    notetakerUrl: "https://app.example.com/notetaker/1",
  };
  return { input, promise: sendNotetakerTurnedOffEmail(input) };
};

const shared = (): SendCase => {
  const input: NotetakerSharedEmailInput = {
    ...baseInput(),
    sharedByName: "Host",
    notetakerUrl: "https://app.example.com/notetaker/1",
  };
  return { input, promise: sendNotetakerSharedEmail(input) };
};

const CASES: ReadonlyArray<readonly [string, string, () => SendCase]> = [
  ["sendNotetakerResultsReadyEmail", "OrganizerNotetakerResultsReadyEmail", resultsReady],
  ["sendNotetakerAttendeeNoticeEmail", "AttendeeNotetakerNoticeEmail", attendeeNotice],
  ["sendNotetakerAdmitPromptEmail", "OrganizerNotetakerAdmitPromptEmail", admitPrompt],
  ["sendNotetakerFailedEmail", "OrganizerNotetakerFailedEmail", () => failed()],
  ["sendNotetakerTurnedOffEmail", "OrganizerNotetakerTurnedOffEmail", turnedOff],
  ["sendNotetakerSharedEmail", "AttendeeNotetakerSharedEmail", shared],
];

describe("notetaker-email-service", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.constructed.length = 0;
    mocks.constructorError.current = null;
    mocks.sendEmail.mockResolvedValue(undefined);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each(CASES)("%s builds %s with the input and sends it", async (_name, template, send) => {
    const { input, promise } = send();

    await expect(promise).resolves.toBeUndefined();

    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.constructed[0].template).toBe(template);
    expect(mocks.constructed[0].input).toBe(input);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(CASES)("%s logs %s and rethrows when sending fails", async (_name, template, send) => {
    const error = new Error("smtp down");
    mocks.sendEmail.mockRejectedValue(error);

    await expect(send().promise).rejects.toBe(error);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      `${template}.sendEmail notetaker-email-service failed (Error)`,
      error
    );
  });

  it("the log line carries no input text", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("smtp down"));

    await expect(
      failed({
        bookingTitle: "SECRET-TITLE-9431",
        to: { email: "secret-host@example.com", name: null },
      }).promise
    ).rejects.toThrow("smtp down");

    const firstArgument = String(consoleError.mock.calls[0][0]);
    expect(firstArgument).not.toContain("SECRET-TITLE-9431");
    expect(firstArgument).not.toContain("secret-host@example.com");
  });

  it("a template that cannot be constructed is logged as Email and rethrown", async () => {
    const error = new TypeError("bad input");
    mocks.constructorError.current = error;

    await expect(failed().promise).rejects.toBe(error);

    expect(consoleError.mock.calls[0][0]).toBe("Email.sendEmail notetaker-email-service failed (TypeError)");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("a non-Error rejection is logged as UnknownError", async () => {
    mocks.sendEmail.mockRejectedValue("nope");

    await expect(failed().promise).rejects.toBe("nope");

    expect(String(consoleError.mock.calls[0][0])).toMatch(/\(UnknownError\)$/);
  });
});
