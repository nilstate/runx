import { createHttpConnectService } from "../connect-http.js";
import { renderKeyValue, statusIcon, theme } from "../ui.js";

export type ConnectAuthorityKind = "read_only" | "constructive" | "destructive";
export type ConnectAction = "list" | "revoke" | "preprovision";

export interface ConnectService {
  readonly list: () => Promise<unknown>;
  readonly preprovision: (request: {
    readonly provider: string;
    readonly scopes: readonly string[];
    readonly scope_family?: string;
    readonly authority_kind?: ConnectAuthorityKind;
    readonly target_repo?: string;
    readonly target_locator?: string;
  }) => Promise<unknown>;
  readonly revoke: (grantId: string) => Promise<unknown>;
}

export interface ConnectCommandArgs {
  readonly connectAction: ConnectAction;
  readonly connectProvider?: string;
  readonly connectGrantId?: string;
  readonly connectScopes: readonly string[];
  readonly connectScopeFamily?: string;
  readonly connectAuthorityKind?: ConnectAuthorityKind;
  readonly connectTargetRepo?: string;
  readonly connectTargetLocator?: string;
}

export async function handleConnectCommand(
  parsed: ConnectCommandArgs,
  connectService: ConnectService,
): Promise<unknown> {
  const result =
    parsed.connectAction === "list"
      ? await connectService.list()
      : parsed.connectAction === "revoke" && parsed.connectGrantId
        ? await connectService.revoke(parsed.connectGrantId)
        : parsed.connectAction === "preprovision" && parsed.connectProvider
          ? await connectService.preprovision({
            provider: parsed.connectProvider,
            scopes: parsed.connectScopes,
            scope_family: parsed.connectScopeFamily,
            authority_kind: parsed.connectAuthorityKind,
            target_repo: parsed.connectTargetRepo,
            target_locator: parsed.connectTargetLocator,
          })
          : undefined;

  if (!result) {
    throw new Error("Invalid runx connect invocation.");
  }

  return result;
}

export function renderConnectResult(
  action: ConnectAction,
  result: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = theme(undefined, env);
  if (action === "list") {
    const grants = isRecord(result) && Array.isArray(result.grants) ? result.grants.filter(isRecord) : [];
    if (grants.length === 0) {
      return `\n  ${t.dim}No connections yet.${t.reset}\n  ${t.dim}start${t.reset}  runx connect github\n\n`;
    }
    const lines = ["", `  ${t.bold}connections${t.reset}  ${t.dim}${grants.length} grant(s)${t.reset}`, ""];
    for (const grant of grants) {
      const grantId = typeof grant.grant_id === "string" ? grant.grant_id : "unknown";
      const provider = typeof grant.provider === "string" ? grant.provider : "unknown";
      const scopes = Array.isArray(grant.scopes) ? grant.scopes.join(", ") : "";
      const scopeFamily = typeof grant.scope_family === "string" ? grant.scope_family : "";
      const authorityKind = typeof grant.authority_kind === "string" ? grant.authority_kind : "";
      const targetRepo = typeof grant.target_repo === "string" ? grant.target_repo : "";
      const targetLocator = typeof grant.target_locator === "string" ? grant.target_locator : "";
      const status = typeof grant.status === "string" ? grant.status : "active";
      lines.push(`  ${statusIcon(status === "revoked" ? "failure" : "success", t)}  ${t.bold}${provider}${t.reset}  ${t.dim}${grantId}${t.reset}`);
      if (scopes) lines.push(`  ${t.dim}scopes${t.reset}  ${scopes}`);
      if (scopeFamily) lines.push(`  ${t.dim}family${t.reset}  ${scopeFamily}`);
      if (authorityKind) lines.push(`  ${t.dim}authority${t.reset}  ${authorityKind}`);
      if (targetRepo) lines.push(`  ${t.dim}repo${t.reset}  ${targetRepo}`);
      if (targetLocator) lines.push(`  ${t.dim}locator${t.reset}  ${targetLocator}`);
      lines.push("");
    }
    return lines.join("\n");
  }
  const grant = isRecord(result) && isRecord(result.grant) ? result.grant : undefined;
  const provider = typeof grant?.provider === "string" ? grant.provider : undefined;
  const grantId = typeof grant?.grant_id === "string" ? grant.grant_id : undefined;
  const scopes = Array.isArray(grant?.scopes) ? grant.scopes.join(", ") : undefined;
  const scopeFamily = typeof grant?.scope_family === "string" ? grant.scope_family : undefined;
  const authorityKind = typeof grant?.authority_kind === "string" ? grant.authority_kind : undefined;
  const targetRepo = typeof grant?.target_repo === "string" ? grant.target_repo : undefined;
  const targetLocator = typeof grant?.target_locator === "string" ? grant.target_locator : undefined;
  const status = isRecord(result) && typeof result.status === "string" ? result.status : "success";
  return renderKeyValue(
    action === "revoke" ? "connection revoked" : "connection ready",
    status === "revoked" || status === "created" || status === "unchanged" ? "success" : status,
    [
      ["provider", provider],
      ["grant", grantId],
      ["scopes", scopes],
      ["family", scopeFamily],
      ["authority", authorityKind],
      ["repo", targetRepo],
      ["locator", targetLocator],
      ["next", action === "revoke" ? "runx connect github" : "runx connect list"],
    ],
    t,
  );
}

export function resolveConfiguredConnectService(env: NodeJS.ProcessEnv): ConnectService | undefined {
  const baseUrl = env.RUNX_CONNECT_BASE_URL;
  const accessToken = env.RUNX_CONNECT_ACCESS_TOKEN;

  if (!baseUrl || !accessToken) {
    return undefined;
  }

  return createHttpConnectService({
    baseUrl,
    accessToken,
    openCommand: env.RUNX_CONNECT_OPEN_COMMAND,
    pollIntervalMs: parseOptionalInt(env.RUNX_CONNECT_POLL_INTERVAL_MS),
    timeoutMs: parseOptionalInt(env.RUNX_CONNECT_TIMEOUT_MS),
    env,
  });
}

export function normalizeConnectAuthorityKind(value: unknown): ConnectAuthorityKind | undefined {
  return value === "read_only" || value === "constructive" || value === "destructive" ? value : undefined;
}

export function parseConnectAction(positionals: readonly string[]): ConnectAction | undefined {
  if (positionals[0] === "list") {
    return "list";
  }
  if (positionals[0] === "revoke") {
    return "revoke";
  }
  return positionals[0] ? "preprovision" : undefined;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
