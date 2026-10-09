import path from "node:path";
import process from "node:process";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  signNotetakerPayload,
} from "@calcom/lib/notetaker/botContract";
import {
  buildFakeEventRequests,
  FAKE_EVENTS_USAGE,
  type FakeEventRequest,
  type FakeEventsOptions,
  parseFakeEventsArgs,
  resolveFakeEventsUrl,
} from "./fakeEventsPlan";

const REQUEST_TIMEOUT_MS = 10_000;

function parseOptions(): FakeEventsOptions | Error {
  try {
    return parseFakeEventsArgs(process.argv.slice(2));
  } catch (error) {
    return error instanceof Error ? error : new Error("Invalid arguments");
  }
}

function loadSecretFromEnvFile(envFile: string | null): void {
  try {
    // loadEnvFile never overrides variables that are already set.
    process.loadEnvFile(envFile ?? path.resolve(__dirname, "../../../.env"));
  } catch {
    // A missing env file is fine: the secret may come from the environment.
  }
}

async function postEvent(
  request: FakeEventRequest,
  url: string,
  secret: string,
  options: FakeEventsOptions
): Promise<number | Error> {
  const timestamp = Math.floor(Date.now() / 1000) + options.timestampOffsetSeconds;
  // A different secret guarantees the app answers 401.
  const signingSecret = options.badSignature ? `${secret}.invalid` : secret;
  const signature = signNotetakerPayload({
    secret: signingSecret,
    timestamp,
    rawBody: request.rawBody,
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [NOTETAKER_TIMESTAMP_HEADER]: String(timestamp),
        [NOTETAKER_SIGNATURE_HEADER]: signature,
      },
      body: request.rawBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.status;
  } catch (error) {
    return error instanceof Error ? error : new Error("unknown");
  }
}

async function main(): Promise<number> {
  const options = parseOptions();
  if (options instanceof Error) {
    process.stderr.write(`${options.message}\n\n${FAKE_EVENTS_USAGE}`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(FAKE_EVENTS_USAGE);
    return 0;
  }

  if (!process.env.NOTETAKER_BOT_SECRET) loadSecretFromEnvFile(options.envFile);
  const secret = process.env.NOTETAKER_BOT_SECRET;
  if (!secret) {
    process.stderr.write(
      "NOTETAKER_BOT_SECRET is not set: export it or point --env-file at a file that defines it\n"
    );
    return 1;
  }

  // Resolved after the env load so a NEXT_PUBLIC_WEBAPP_URL from the file is seen.
  const url = resolveFakeEventsUrl(options, process.env.NEXT_PUBLIC_WEBAPP_URL);

  for (const request of buildFakeEventRequests(options, new Date())) {
    const result = await postEvent(request, url, secret, options);
    if (result instanceof Error) {
      process.stderr.write(`${request.sequence} ${request.type} -> request failed (${result.name})\n`);
      return 1;
    }
    // Non-2xx is not a failure here: the script exists to provoke 401, 400 and 410.
    process.stdout.write(`${request.sequence} ${request.type} -> ${result}\n`);
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
