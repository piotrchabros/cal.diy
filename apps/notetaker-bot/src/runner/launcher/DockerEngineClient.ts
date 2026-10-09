// UNVERIFIED AGAINST THE REAL SERVICE (Docker Engine API): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/deployment.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import { Buffer } from "node:buffer";
import { request } from "node:http";
import { z } from "zod";

const DEFAULT_API_VERSION = "v1.43";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const createResponseSchema = z.object({ Id: z.string() });
const inspectResponseSchema = z.object({ Id: z.string(), State: z.object({ Running: z.boolean() }) });
const listResponseSchema = z.array(
  z.object({ Id: z.string(), Names: z.array(z.string()).optional(), State: z.string() })
);

type SendOptions = { query?: Record<string, string>; body?: unknown; timeoutMs?: number };
type SendResult = { status: number; text: string };

// Messages never carry response bodies, request bodies, env values or container names: the create
// request holds the join request secret and the Engine echoes names and images back in errors.
class DockerEngineError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "DockerEngineError";
    this.status = status;
  }
}

const statusError = (operation: string, status: number): DockerEngineError =>
  new DockerEngineError(`Docker Engine ${operation} failed with status ${status}`, status);

const unexpectedResponseError = (operation: string): DockerEngineError =>
  new DockerEngineError(`Docker Engine ${operation} returned an unexpected response`);

const errorCodeOf = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "request error";
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && code !== "" ? code : "request error";
};

const parseJson = <T>(operation: string, text: string, schema: z.ZodType<T>): T => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw unexpectedResponseError(operation);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw unexpectedResponseError(operation);
  return parsed.data;
};

const stripLeadingSlash = (name: string): string => (name.startsWith("/") ? name.slice(1) : name);

type DockerContainerSpec = {
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  shmSizeBytes: number;
  networkMode: string | null;
};

interface IDockerEngine {
  ping(): Promise<boolean>;
  createContainer(spec: DockerContainerSpec): Promise<{ id: string; alreadyExists: boolean }>;
  startContainer(id: string): Promise<void>;
  inspectContainer(idOrName: string): Promise<{ id: string; running: boolean } | null>;
  listContainers(label: string): Promise<{ id: string; name: string; running: boolean }[]>;
  readLogTail(id: string, lines: number): Promise<string>;
  stopContainer(id: string, graceSeconds: number): Promise<void>;
  removeContainer(id: string): Promise<void>;
}

class DockerEngineClient implements IDockerEngine {
  private readonly transport: { socketPath: string } | { host: string; port: number };
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(
    options: ({ socketPath: string } | { host: string; port: number }) & {
      apiVersion?: string;
      timeoutMs?: number;
    }
  ) {
    this.transport =
      "socketPath" in options
        ? { socketPath: options.socketPath }
        : { host: options.host, port: options.port };
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.send("ping", "GET", "/_ping");
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async createContainer(spec: DockerContainerSpec): Promise<{ id: string; alreadyExists: boolean }> {
    const response = await this.send("createContainer", "POST", "/containers/create", {
      query: { name: spec.name },
      body: {
        Image: spec.image,
        Env: spec.env,
        Labels: spec.labels,
        Tty: true,
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        OpenStdin: false,
        HostConfig: {
          AutoRemove: true,
          ShmSize: spec.shmSizeBytes,
          ...(spec.networkMode === null ? {} : { NetworkMode: spec.networkMode }),
        },
      },
    });
    if (response.status === 201) {
      const created = parseJson("createContainer", response.text, createResponseSchema);
      return { id: created.Id, alreadyExists: false };
    }
    if (response.status !== 409) throw statusError("createContainer", response.status);

    const existing = await this.inspectContainer(spec.name);
    if (existing === null) throw statusError("createContainer", 409);
    return { id: existing.id, alreadyExists: true };
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.send("startContainer", "POST", `/containers/${encodeURIComponent(id)}/start`);
    if (response.status === 204 || response.status === 304) return;
    throw statusError("startContainer", response.status);
  }

  async inspectContainer(idOrName: string): Promise<{ id: string; running: boolean } | null> {
    const response = await this.send(
      "inspectContainer",
      "GET",
      `/containers/${encodeURIComponent(idOrName)}/json`
    );
    if (response.status === 404) return null;
    if (response.status !== 200) throw statusError("inspectContainer", response.status);
    const inspected = parseJson("inspectContainer", response.text, inspectResponseSchema);
    return { id: inspected.Id, running: inspected.State.Running };
  }

  async listContainers(label: string): Promise<{ id: string; name: string; running: boolean }[]> {
    const response = await this.send("listContainers", "GET", "/containers/json", {
      query: { all: "true", filters: JSON.stringify({ label: [label] }) },
    });
    if (response.status !== 200) throw statusError("listContainers", response.status);
    const rows = parseJson("listContainers", response.text, listResponseSchema);
    return rows.map((row) => ({
      id: row.Id,
      name: stripLeadingSlash(row.Names?.[0] ?? ""),
      running: row.State === "running",
    }));
  }

  async readLogTail(id: string, lines: number): Promise<string> {
    const response = await this.send("readLogTail", "GET", `/containers/${encodeURIComponent(id)}/logs`, {
      query: { stdout: "true", stderr: "true", tail: String(lines) },
    });
    if (response.status === 404) return "";
    if (response.status !== 200) throw statusError("readLogTail", response.status);
    return response.text;
  }

  async stopContainer(id: string, graceSeconds: number): Promise<void> {
    // The Engine holds the request open until the container has stopped, so the grace period adds to the wait.
    const response = await this.send("stopContainer", "POST", `/containers/${encodeURIComponent(id)}/stop`, {
      query: { t: String(graceSeconds) },
      timeoutMs: this.timeoutMs + graceSeconds * 1000,
    });
    if (response.status === 204 || response.status === 304 || response.status === 404) return;
    throw statusError("stopContainer", response.status);
  }

  async removeContainer(id: string): Promise<void> {
    const response = await this.send("removeContainer", "DELETE", `/containers/${encodeURIComponent(id)}`, {
      query: { force: "true", v: "true" },
    });
    if (response.status === 204 || response.status === 404 || response.status === 409) return;
    throw statusError("removeContainer", response.status);
  }

  private send(
    operation: string,
    method: string,
    path: string,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const queryString = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const fullPath = `/${this.apiVersion}${path}${queryString}`;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const headers: Record<string, string | number> =
      payload === null
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };

    return new Promise<SendResult>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish();
      };

      const req = request({ ...this.transport, agent: false, method, path: fullPath, headers }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            settle(() => reject(unexpectedResponseError(operation)));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          settle(() =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
          );
        });
        res.on("error", (error) => {
          settle(() =>
            reject(new DockerEngineError(`Docker Engine ${operation} failed: ${errorCodeOf(error)}`))
          );
        });
      });

      const timer = setTimeout(() => {
        settle(() =>
          reject(new DockerEngineError(`Docker Engine ${operation} timed out after ${timeoutMs} ms`))
        );
        req.destroy();
      }, timeoutMs);

      req.on("error", (error) => {
        settle(() =>
          reject(new DockerEngineError(`Docker Engine ${operation} failed: ${errorCodeOf(error)}`))
        );
      });

      if (payload !== null) req.write(payload);
      req.end();
    });
  }
}

export type { DockerContainerSpec, IDockerEngine };
export { DockerEngineClient };
