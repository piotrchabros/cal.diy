// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StubHttpServer, StubResponse } from "../../testing/httpTestKit";
import { startStubHttpServer, useRealFetch } from "../../testing/httpTestKit";
import type { DockerContainerSpec } from "./DockerEngineClient";
import { DockerEngineClient } from "./DockerEngineClient";
import { encodeRunnerStatus, findLastRunnerStatus } from "./runnerStatusProtocol";

const SESSION_LABEL = "com.cal.notetaker.session";
const RESPONSE_MARKER = "response-body-marker-not-real";
const ENV_SECRET = "env-secret-value-not-real";

let stub: StubHttpServer;
let client: DockerEngineClient;

const stubPort = (): number => Number(new URL(stub.url).port);

const createClient = (overrides: { timeoutMs?: number; apiVersion?: string } = {}): DockerEngineClient =>
  new DockerEngineClient({ host: "127.0.0.1", port: stubPort(), timeoutMs: 500, ...overrides });

const lastRequest = () => {
  const request = stub.requests.at(-1);
  if (!request) throw new Error("Expected the stub server to have received a request");
  return request;
};

const parsePath = (path: string): { pathname: string; query: Record<string, string> } => {
  const url = new URL(path, "http://x");
  return { pathname: url.pathname, query: Object.fromEntries(url.searchParams) };
};

const answerWith = (response: StubResponse): void => {
  stub.respondWith(() => response);
};

const buildSpec = (overrides: Partial<DockerContainerSpec> = {}): DockerContainerSpec => ({
  name: "notetaker-session-1",
  image: "runner:test",
  env: [`NOTETAKER_BOT_SECRET=${ENV_SECRET}`, "TZ=UTC"],
  labels: { [SESSION_LABEL]: "session-1" },
  shmSizeBytes: 1073741824,
  networkMode: "bridge",
  ...overrides,
});

const parseBody = (rawBody: string): unknown => JSON.parse(rawBody);

const createBodyOf = (rawBody: string): { HostConfig: Record<string, unknown> } & Record<string, unknown> => {
  const parsed = parseBody(rawBody);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Create body is not an object");
  const hostConfig: unknown = Reflect.get(parsed, "HostConfig");
  if (typeof hostConfig !== "object" || hostConfig === null) throw new Error("Create body has no HostConfig");
  return { ...Object.fromEntries(Object.entries(parsed)), HostConfig: { ...hostConfig } };
};

const delayedAnswer = (status: number, delayMs: number): Promise<StubResponse> =>
  new Promise<StubResponse>((resolve) => {
    setTimeout(() => resolve({ status }), delayMs);
  });

beforeEach(async () => {
  useRealFetch();
  stub = await startStubHttpServer();
  client = createClient();
});

afterEach(async () => {
  await stub.close();
});

describe("DockerEngineClient", () => {
  describe("ping", () => {
    it("sends GET _ping without a body and returns true on 200", async () => {
      answerWith({ status: 200, body: "OK" });

      await expect(client.ping()).resolves.toBe(true);

      const request = lastRequest();
      expect(request.method).toBe("GET");
      expect(request.path).toBe("/v1.43/_ping");
      expect(request.rawBody).toBe("");
    });

    it("returns false on 500 and when nothing listens", async () => {
      answerWith({ status: 500 });
      await expect(client.ping()).resolves.toBe(false);

      await stub.close();
      await expect(client.ping()).resolves.toBe(false);
    });
  });

  describe("createContainer", () => {
    it("posts the full create body with the name as the only query parameter", async () => {
      answerWith({ status: 201, body: '{"Id":"abc123","Warnings":[]}' });

      const result = await client.createContainer(buildSpec());

      expect(result).toEqual({ id: "abc123", alreadyExists: false });
      const request = lastRequest();
      expect(request.method).toBe("POST");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(parsePath(request.path)).toEqual({
        pathname: "/v1.43/containers/create",
        query: { name: "notetaker-session-1" },
      });
      expect(parseBody(request.rawBody)).toEqual({
        Image: "runner:test",
        Env: [`NOTETAKER_BOT_SECRET=${ENV_SECRET}`, "TZ=UTC"],
        Labels: { [SESSION_LABEL]: "session-1" },
        Tty: true,
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        OpenStdin: false,
        HostConfig: { AutoRemove: true, ShmSize: 1073741824, NetworkMode: "bridge" },
      });
    });

    it("omits NetworkMode when networkMode is null", async () => {
      answerWith({ status: 201, body: '{"Id":"abc123"}' });

      await client.createContainer(buildSpec({ networkMode: null }));

      const body = createBodyOf(lastRequest().rawBody);
      expect(Object.keys(body.HostConfig).sort()).toEqual(["AutoRemove", "ShmSize"]);
    });

    it("never sends Binds, Mounts or Volumes", async () => {
      answerWith({ status: 201, body: '{"Id":"abc123"}' });

      await client.createContainer(buildSpec());

      const { rawBody } = lastRequest();
      const body = createBodyOf(rawBody);
      for (const key of ["Binds", "Mounts", "Volumes"]) {
        expect(body).not.toHaveProperty(key);
        expect(body.HostConfig).not.toHaveProperty(key);
        expect(rawBody).not.toContain(key);
      }
    });

    it("inspects by name on 409 and reports the existing container", async () => {
      stub.respondWith((_request, index) =>
        index === 0 ? { status: 409 } : { status: 200, body: '{"Id":"existing","State":{"Running":true}}' }
      );

      const result = await client.createContainer(buildSpec());

      expect(result).toEqual({ id: "existing", alreadyExists: true });
      expect(stub.requests).toHaveLength(2);
      const second = stub.requests[1];
      expect(second?.method).toBe("GET");
      expect(second?.path).toBe("/v1.43/containers/notetaker-session-1/json");
    });

    it("rejects with status 409 when the conflicting container cannot be inspected", async () => {
      stub.respondWith((_request, index) => (index === 0 ? { status: 409 } : { status: 404 }));

      await expect(client.createContainer(buildSpec())).rejects.toThrow(/status 409/);
    });

    it.each([404, 500])("rejects on status %i without leaking the response body", async (status) => {
      answerWith({ status, body: JSON.stringify({ message: RESPONSE_MARKER }) });

      const error = await client.createContainer(buildSpec()).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(new RegExp(`createContainer failed with status ${status}`));
      expect(message).not.toContain(RESPONSE_MARKER);
    });
  });

  describe("startContainer", () => {
    it("posts without a body and accepts 204 and 304", async () => {
      answerWith({ status: 204 });
      await expect(client.startContainer("abc")).resolves.toBeUndefined();

      const request = lastRequest();
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1.43/containers/abc/start");
      expect(request.rawBody).toBe("");

      answerWith({ status: 304 });
      await expect(client.startContainer("abc")).resolves.toBeUndefined();
    });

    it("rejects on 404", async () => {
      answerWith({ status: 404 });

      await expect(client.startContainer("abc")).rejects.toThrow(/startContainer failed with status 404/);
    });
  });

  describe("inspectContainer", () => {
    it("returns id and running state", async () => {
      answerWith({ status: 200, body: '{"Id":"abc","State":{"Running":true}}' });
      await expect(client.inspectContainer("abc")).resolves.toEqual({ id: "abc", running: true });

      const request = lastRequest();
      expect(request.method).toBe("GET");
      expect(request.path).toBe("/v1.43/containers/abc/json");

      answerWith({ status: 200, body: '{"Id":"abc","State":{"Running":false}}' });
      await expect(client.inspectContainer("abc")).resolves.toEqual({ id: "abc", running: false });
    });

    it("returns null on 404 and rejects on 500", async () => {
      answerWith({ status: 404 });
      await expect(client.inspectContainer("abc")).resolves.toBeNull();

      answerWith({ status: 500 });
      await expect(client.inspectContainer("abc")).rejects.toThrow(/status 500/);
    });

    it("percent-encodes the name in the path", async () => {
      answerWith({ status: 404 });

      await client.inspectContainer("a/b c");

      expect(lastRequest().path).toBe("/v1.43/containers/a%2Fb%20c/json");
    });
  });

  describe("listContainers", () => {
    it("filters by label and maps rows", async () => {
      answerWith({
        status: 200,
        body: JSON.stringify([
          { Id: "one", Names: ["/notetaker-one"], State: "running" },
          { Id: "two", Names: ["/notetaker-two"], State: "exited" },
        ]),
      });

      const result = await client.listContainers(SESSION_LABEL);

      expect(result).toEqual([
        { id: "one", name: "notetaker-one", running: true },
        { id: "two", name: "notetaker-two", running: false },
      ]);
      const request = lastRequest();
      expect(request.method).toBe("GET");
      const { pathname, query } = parsePath(request.path);
      expect(pathname).toBe("/v1.43/containers/json");
      expect(query.all).toBe("true");
      expect(JSON.parse(query.filters ?? "")).toEqual({ label: [SESSION_LABEL] });
    });

    it("rejects on a body that is not the expected JSON", async () => {
      answerWith({ status: 200, body: '{"not":"an array"}' });

      await expect(client.listContainers(SESSION_LABEL)).rejects.toThrow(/unexpected response/);
    });
  });

  describe("readLogTail", () => {
    it("requests the tail and returns the raw text unchanged", async () => {
      const text = `starting\r\n${encodeRunnerStatus({ phase: "IN_MEETING", lastEventSequence: 4 })}\r\n`;
      answerWith({ status: 200, body: text });

      const result = await client.readLogTail("abc", 50);

      expect(result).toBe(text);
      expect(findLastRunnerStatus(result)).toEqual({ phase: "IN_MEETING", lastEventSequence: 4 });
      const request = lastRequest();
      expect(request.method).toBe("GET");
      expect(parsePath(request.path)).toEqual({
        pathname: "/v1.43/containers/abc/logs",
        query: { stdout: "true", stderr: "true", tail: "50" },
      });
    });

    it("returns an empty string on 404", async () => {
      answerWith({ status: 404 });

      await expect(client.readLogTail("abc", 50)).resolves.toBe("");
    });
  });

  describe("stopContainer", () => {
    it("posts with the grace in seconds and accepts 204, 304 and 404", async () => {
      for (const status of [204, 304, 404]) {
        answerWith({ status });
        await expect(client.stopContainer("abc", 15)).resolves.toBeUndefined();
      }

      const request = lastRequest();
      expect(request.method).toBe("POST");
      expect(parsePath(request.path)).toEqual({
        pathname: "/v1.43/containers/abc/stop",
        query: { t: "15" },
      });
    });

    it("rejects on 500", async () => {
      answerWith({ status: 500 });

      await expect(client.stopContainer("abc", 15)).rejects.toThrow(/stopContainer failed with status 500/);
    });
  });

  describe("removeContainer", () => {
    it("deletes with force and volumes and accepts 204, 404 and 409", async () => {
      for (const status of [204, 404, 409]) {
        answerWith({ status });
        await expect(client.removeContainer("abc")).resolves.toBeUndefined();
      }

      const request = lastRequest();
      expect(request.method).toBe("DELETE");
      expect(parsePath(request.path)).toEqual({
        pathname: "/v1.43/containers/abc",
        query: { force: "true", v: "true" },
      });
    });

    it("rejects on 500", async () => {
      answerWith({ status: 500 });

      await expect(client.removeContainer("abc")).rejects.toThrow(/removeContainer failed with status 500/);
    });
  });

  describe("timeouts and transport", () => {
    it("rejects when the request gets no answer within the timeout", async () => {
      stub.respondWith(() => new Promise<StubResponse>(() => {}));
      const shortClient = createClient({ timeoutMs: 100 });
      const startedAt = Date.now();

      await expect(shortClient.inspectContainer("abc")).rejects.toThrow(/timed out after 100 ms/);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    it("lets stopContainer wait for the grace on top of the timeout", async () => {
      stub.respondWith(() => delayedAnswer(204, 200));
      const shortClient = createClient({ timeoutMs: 50 });

      await expect(shortClient.stopContainer("abc", 1)).resolves.toBeUndefined();
      await expect(shortClient.inspectContainer("abc")).rejects.toThrow(/timed out after 50 ms/);
    });

    it("uses a custom apiVersion as the path prefix", async () => {
      answerWith({ status: 200, body: "OK" });

      await createClient({ apiVersion: "v1.44" }).ping();

      expect(lastRequest().path).toBe("/v1.44/_ping");
    });

    it("rejects a connection error with a DockerEngineError that does not leak the spec", async () => {
      await stub.close();

      const error = await client.createContainer(buildSpec()).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.name : "").toBe("DockerEngineError");
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/createContainer/);
      expect(message).not.toContain(ENV_SECRET);
      expect(message).not.toContain("notetaker-session-1");
    });
  });
});
