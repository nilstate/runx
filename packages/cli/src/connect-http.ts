import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface HttpConnectGrant {
  readonly grant_id: string;
  readonly principal_id?: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly connection_id?: string;
  readonly status: "active" | "revoked";
  readonly created_at?: string;
}

export interface HttpConnectListResponse {
  readonly grants: readonly HttpConnectGrant[];
}

export interface HttpConnectRevokeResponse {
  readonly status: "revoked";
  readonly grant: HttpConnectGrant;
}

export interface HttpConnectStartReadyResponse {
  readonly status: "created" | "unchanged";
  readonly grant: HttpConnectGrant;
}

export interface HttpConnectStartOauthResponse {
  readonly status: "oauth_required";
  readonly flow_id: string;
  readonly authorize_url: string;
  readonly poll_after_ms?: number;
  readonly expires_at?: string;
}

export interface HttpConnectFlowPendingResponse {
  readonly status: "pending";
  readonly flow_id: string;
  readonly poll_after_ms?: number;
}

export interface HttpConnectFlowFailedResponse {
  readonly status: "failed";
  readonly flow_id: string;
  readonly error: string;
}

export type HttpConnectStartResponse = HttpConnectStartReadyResponse | HttpConnectStartOauthResponse;
export type HttpConnectFlowResponse =
  | HttpConnectStartReadyResponse
  | HttpConnectFlowPendingResponse
  | HttpConnectFlowFailedResponse;

export interface HttpConnectServiceOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly openCommand?: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function createHttpConnectService(options: HttpConnectServiceOptions): {
  readonly list: () => Promise<HttpConnectListResponse>;
  readonly preprovision: (
    provider: string,
    scopes: readonly string[],
  ) => Promise<HttpConnectStartReadyResponse>;
  readonly revoke: (grantId: string) => Promise<HttpConnectRevokeResponse>;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    list: async () =>
      await requestJson<HttpConnectListResponse>(fetchImpl, `${baseUrl}/v1/connect/grants`, {
        method: "GET",
        headers: authHeaders(options.accessToken),
      }),
    preprovision: async (provider, scopes) => {
      const started = await requestJson<HttpConnectStartResponse>(fetchImpl, `${baseUrl}/v1/connect/flows`, {
        method: "POST",
        headers: authHeaders(options.accessToken),
        body: JSON.stringify({ provider, scopes }),
      });

      if (started.status === "created" || started.status === "unchanged") {
        return started;
      }

      if (started.status === "oauth_required") {
        const pending = started as HttpConnectStartOauthResponse;
        await openConnectUrl(pending.authorize_url, {
          command: options.openCommand,
          env: options.env,
        });

        return await waitForConnectFlow({
          fetchImpl,
          baseUrl,
          accessToken: options.accessToken,
          flowId: pending.flow_id,
          pollAfterMs: pending.poll_after_ms,
          pollIntervalMs: options.pollIntervalMs,
          timeoutMs: options.timeoutMs,
        });
      }

      throw new Error(`Unsupported connect start status: ${String((started as { status?: unknown }).status)}`);
    },
    revoke: async (grantId) =>
      await requestJson<HttpConnectRevokeResponse>(fetchImpl, `${baseUrl}/v1/connect/grants/${encodeURIComponent(grantId)}`, {
        method: "DELETE",
        headers: authHeaders(options.accessToken),
      }),
  };
}

async function waitForConnectFlow(options: {
  readonly fetchImpl: typeof fetch;
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly flowId: string;
  readonly pollAfterMs?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}): Promise<HttpConnectStartReadyResponse> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;

  while (true) {
    const polled = await requestJson<HttpConnectFlowResponse>(
      options.fetchImpl,
      `${options.baseUrl}/v1/connect/flows/${encodeURIComponent(options.flowId)}`,
      {
        method: "GET",
        headers: authHeaders(options.accessToken),
      },
    );

    if (polled.status === "created" || polled.status === "unchanged") {
      return polled;
    }

    if (polled.status === "failed") {
      throw new Error(polled.error);
    }

    if (polled.status === "pending") {
      const pending = polled as HttpConnectFlowPendingResponse;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for OAuth flow '${options.flowId}' to complete.`);
      }

      await delay(pending.poll_after_ms ?? options.pollAfterMs ?? options.pollIntervalMs ?? 750);
      continue;
    }

    throw new Error(`Unsupported connect flow status: ${String((polled as { status?: unknown }).status)}`);
  }
}

async function requestJson<T>(fetchImpl: typeof fetch, input: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(input, init);
  const raw = await response.text();
  const data = raw.length > 0 ? safeJson(raw) : undefined;
  if (!response.ok) {
    const message =
      isRecord(data) && typeof data.error === "string"
        ? data.error
        : raw.length > 0
          ? raw
          : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function authHeaders(accessToken: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

async function openConnectUrl(
  url: string,
  options: { readonly command?: string; readonly env?: NodeJS.ProcessEnv },
): Promise<void> {
  if (options.command) {
    await runShellCommand(options.command, url, options.env);
    return;
  }

  if (process.platform === "darwin") {
    await runProcess("open", [url], options.env);
    return;
  }

  if (process.platform === "win32") {
    await runProcess("cmd", ["/c", "start", "", url], options.env);
    return;
  }

  await runProcess("xdg-open", [url], options.env);
}

async function runShellCommand(command: string, url: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "ignore",
      env: { ...process.env, ...env, RUNX_CONNECT_URL: url },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Connect opener command failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

async function runProcess(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      env: { ...process.env, ...env, RUNX_CONNECT_URL: args[args.length - 1] ?? "" },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Connect opener process '${command}' failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
