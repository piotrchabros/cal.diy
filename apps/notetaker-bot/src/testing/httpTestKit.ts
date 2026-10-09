import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  signNotetakerPayload,
} from "@calcom/lib/notetaker/botContract";

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
};

export type StubResponse = { status: number; body?: string };

export type StubHttpServer = {
  url: string;
  requests: RecordedRequest[];
  respondWith(
    handler: (request: RecordedRequest, index: number) => StubResponse | Promise<StubResponse>
  ): void;
  close(): Promise<void>;
};

type StubHandler = Parameters<StubHttpServer["respondWith"]>[0];

const defaultHandler: StubHandler = () => ({ status: 200, body: '{"ok":true}' });

export async function startStubHttpServer(): Promise<StubHttpServer> {
  const requests: RecordedRequest[] = [];
  let handler: StubHandler = defaultHandler;

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }

      const request: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        rawBody: Buffer.concat(chunks).toString("utf8"),
      };
      const index = requests.push(request) - 1;

      const response = await handler(request, index);
      if (response.body === undefined) {
        res.writeHead(response.status);
      } else {
        res.writeHead(response.status, { "content-type": "application/json" });
      }
      res.end(response.body);
    } catch {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Stub HTTP server did not bind to a TCP port, address was ${String(address)}`);
  }

  let closing: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    respondWith(next) {
      handler = next;
    },
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Hung handlers and keep-alive sockets would otherwise keep close() from ever resolving.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export function useRealFetch(): void {
  // The repository-root Vitest setup swaps the global fetch for vitest-fetch-mock, which answers
  // 200 without touching the network; tests that talk to a stub server need the real fetch back.
  // This workspace's own Vitest config has no setup file, so the mock may be absent.
  const candidate: unknown = Reflect.get(globalThis, "fetchMock");
  if (typeof candidate !== "function") return;
  if (!("disableMocks" in candidate)) return;
  if (typeof candidate.disableMocks !== "function") return;
  Reflect.apply(candidate.disableMocks, candidate, []);
}

export function buildSignedHeaders(input: {
  secret: string;
  rawBody: string;
  timestampSeconds?: number;
}): Record<string, string> {
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  return {
    [NOTETAKER_TIMESTAMP_HEADER]: String(timestamp),
    [NOTETAKER_SIGNATURE_HEADER]: signNotetakerPayload({
      secret: input.secret,
      timestamp,
      rawBody: input.rawBody,
    }),
  };
}

export function buildJoinRequest(overrides: Partial<NotetakerBotJoinRequest> = {}): NotetakerBotJoinRequest {
  const base: NotetakerBotJoinRequest = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "Example Notetaker for Jane Host",
    noticeMessage:
      "This meeting is being transcribed by an automated notetaker on behalf of Jane Host. Remove the notetaker to stop transcription.",
    scheduledStartAt: "2030-01-01T10:00:00.000Z",
    callbackUrl: "https://app.example.test/api/notetaker/events",
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 14400,
    },
  };
  return { ...base, ...overrides };
}
