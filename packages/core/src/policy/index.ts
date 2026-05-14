export const policyPackage = "@runxhq/core/policy";

import path from "node:path";

import { isRecord } from "../util/types.js";
import { unique } from "../util/array.js";

import { admitSandbox } from "./sandbox.js";

export interface LocalAdmissionSkill {
  readonly name: string;
  readonly source: {
    readonly type: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly timeoutSeconds?: number;
    readonly sandbox?: LocalAdmissionSandbox;
  };
  readonly auth?: unknown;
  readonly runtime?: unknown;
}

export interface LocalAdmissionSandbox {
  readonly profile: "readonly" | "workspace-write" | "network" | "unrestricted-local-dev";
  readonly cwdPolicy?: "skill-directory" | "workspace" | "custom";
  readonly envAllowlist?: readonly string[];
  readonly network?: boolean;
  readonly writablePaths?: readonly string[];
  readonly requireEnforcement?: boolean;
}

export interface LocalAdmissionOptions {
  readonly allowedSourceTypes?: readonly string[];
  readonly maxTimeoutSeconds?: number;
  readonly connectedGrants?: readonly LocalAdmissionGrant[];
  readonly skipConnectedAuth?: boolean;
  readonly approvedSandboxEscalation?: boolean;
  readonly skipSandboxEscalation?: boolean;
  readonly executionPolicy?: LocalExecutionPolicy;
}

export interface LocalExecutionPolicy {
  readonly strictCliToolInlineCode?: boolean;
}

export interface LocalAdmissionGrant {
  readonly grant_id: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly status?: "active" | "revoked";
}

export interface RetryAdmissionRequest {
  readonly stepId: string;
  readonly retry?: {
    readonly maxAttempts: number;
  };
  readonly mutating?: boolean;
  readonly idempotencyKey?: string;
}

export interface GraphScopeGrant {
  readonly grant_id?: string;
  readonly scopes: readonly string[];
}

export interface GraphScopeAdmissionRequest {
  readonly stepId: string;
  readonly requestedScopes: readonly string[];
  readonly grant: GraphScopeGrant;
}

export type AdmissionDecision =
  | { readonly status: "allow"; readonly reasons: readonly string[] }
  | { readonly status: "deny"; readonly reasons: readonly string[] };

export type GraphScopeAdmissionDecision =
  | {
      readonly status: "allow";
      readonly reasons: readonly string[];
      readonly stepId: string;
      readonly requestedScopes: readonly string[];
      readonly grantedScopes: readonly string[];
      readonly grantId?: string;
    }
  | {
      readonly status: "deny";
      readonly reasons: readonly string[];
      readonly stepId: string;
      readonly requestedScopes: readonly string[];
      readonly grantedScopes: readonly string[];
      readonly grantId?: string;
    };

export function admitLocalSkill(
  skill: LocalAdmissionSkill,
  options: LocalAdmissionOptions = {},
): AdmissionDecision {
  const allowedSourceTypes = options.allowedSourceTypes ?? ["agent", "agent-step", "approval", "cli-tool", "mcp", "a2a", "catalog", "graph"];
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;
  const reasons: string[] = [];

  if (!allowedSourceTypes.includes(skill.source.type)) {
    reasons.push(`source type '${skill.source.type}' is not allowed for local execution`);
  }

  if (skill.source.timeoutSeconds !== undefined) {
    if (skill.source.timeoutSeconds <= 0) {
      reasons.push("source timeout must be greater than zero seconds");
    }
    if (skill.source.timeoutSeconds > maxTimeoutSeconds) {
      reasons.push(`source timeout exceeds local maximum of ${maxTimeoutSeconds} seconds`);
    }
  }

  if (skill.source.type === "cli-tool" || skill.source.type === "mcp") {
    const sandboxDecision = admitSandbox(skill.source.sandbox, {
      approvedEscalation: options.approvedSandboxEscalation,
      skipEscalation: options.skipSandboxEscalation,
    });
    if (sandboxDecision.status !== "allow") {
      reasons.push(...sandboxDecision.reasons);
    }
    const inlineCodeReason =
      options.executionPolicy?.strictCliToolInlineCode
        ? inlineCliToolViolation(skill.source.command, skill.source.args)
        : undefined;
    if (inlineCodeReason) {
      reasons.push(inlineCodeReason);
    }
  }

  const authRequirement = options.skipConnectedAuth ? undefined : connectedAuthRequirement(skill.auth);
  if (authRequirement) {
    const grant = findMatchingGrant(authRequirement, options.connectedGrants ?? []);
    if (!grant) {
      reasons.push(`connected auth grant required for provider '${authRequirement.provider}'`);
    }
  }

  if (reasons.length > 0) {
    return {
      status: "deny",
      reasons,
    };
  }

  return {
    status: "allow",
    reasons: ["local admission allowed"],
  };
}

export function admitRetryPolicy(request: RetryAdmissionRequest): AdmissionDecision {
  const maxAttempts = request.retry?.maxAttempts ?? 1;
  if (maxAttempts <= 1) {
    return {
      status: "allow",
      reasons: ["retry policy not requested"],
    };
  }

  if (request.mutating && !request.idempotencyKey) {
    return {
      status: "deny",
      reasons: [`step '${request.stepId}' declares mutating retry without an idempotency key`],
    };
  }

  return {
    status: "allow",
    reasons: ["retry policy allowed"],
  };
}

export function admitGraphStepScopes(request: GraphScopeAdmissionRequest): GraphScopeAdmissionDecision {
  const requestedScopes = unique(request.requestedScopes);
  const grantedScopes = unique(request.grant.scopes);
  const deniedScopes = requestedScopes.filter((scope) => !grantedScopes.some((grantedScope) => scopeAllows(grantedScope, scope)));

  if (deniedScopes.length > 0) {
    return {
      status: "deny",
      reasons: [`step '${request.stepId}' requested scope(s) outside graph grant: ${deniedScopes.join(", ")}`],
      stepId: request.stepId,
      requestedScopes,
      grantedScopes,
      grantId: request.grant.grant_id,
    };
  }

  return {
    status: "allow",
    reasons: requestedScopes.length > 0 ? ["graph step scopes allowed"] : ["graph step requested no scopes"],
    stepId: request.stepId,
    requestedScopes,
    grantedScopes,
    grantId: request.grant.grant_id,
  };
}

function connectedAuthRequirement(auth: unknown): { readonly provider: string; readonly scopes: readonly string[] } | undefined {
  if (auth === undefined || auth === null || auth === false) {
    return undefined;
  }

  if (!isRecord(auth)) {
    return {
      provider: "unknown",
      scopes: [],
    };
  }

  const type = auth.type;
  if (type === "env" || type === "none" || type === "local") {
    return undefined;
  }

  return {
    provider: typeof auth.provider === "string" ? auth.provider : typeof type === "string" ? type : "unknown",
    scopes: Array.isArray(auth.scopes) ? auth.scopes.filter((scope): scope is string => typeof scope === "string") : [],
  };
}

function inlineCliToolViolation(command: string | undefined, args: readonly string[] | undefined): string | undefined {
  const interpreter = detectInlineInterpreter(command, args ?? []);
  if (!interpreter) {
    return undefined;
  }
  return `cli-tool source '${interpreter.command}' uses inline code via '${interpreter.trigger}', which is rejected by strict workspace policy; move the program into a checked-in script and invoke that file instead`;
}

function detectInlineInterpreter(
  command: string | undefined,
  args: readonly string[],
): { readonly command: string; readonly trigger: string } | undefined {
  const commandName = normalizeExecutableName(command);
  if (!commandName) {
    return undefined;
  }

  if (commandName === "env") {
    const forwarded = unwrapEnvCommand(args);
    if (!forwarded) {
      return undefined;
    }
    return detectInlineInterpreter(forwarded.command, forwarded.args);
  }

  const loweredArgs = args.map((arg) => String(arg).trim());

  if (["node", "nodejs", "bun"].includes(commandName)) {
    const trigger = findExactArg(loweredArgs, ["-e", "--eval", "-p", "--print"]);
    return trigger ? { command: commandName, trigger } : undefined;
  }

  if (commandName === "deno") {
    return loweredArgs[0]?.toLowerCase() === "eval"
      ? { command: commandName, trigger: loweredArgs[0] }
      : undefined;
  }

  if (isPythonLike(commandName)) {
    const trigger = findExactArg(loweredArgs, ["-c"]);
    return trigger ? { command: commandName, trigger } : undefined;
  }

  if (["ruby", "perl", "lua"].includes(commandName)) {
    const trigger = findExactArg(loweredArgs, ["-e"]);
    return trigger ? { command: commandName, trigger } : undefined;
  }

  if (commandName === "php") {
    const trigger = findExactArg(loweredArgs, ["-r"]);
    return trigger ? { command: commandName, trigger } : undefined;
  }

  if (["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"].includes(commandName)) {
    const trigger = loweredArgs.find((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    return trigger ? { command: commandName, trigger } : undefined;
  }

  if (["pwsh", "powershell"].includes(commandName)) {
    const trigger = findExactArg(loweredArgs, ["-c", "-command", "-encodedcommand"]);
    return trigger ? { command: commandName, trigger } : undefined;
  }

  if (commandName === "cmd") {
    const trigger = findExactArg(loweredArgs.map((arg) => arg.toLowerCase()), ["/c", "/k"]);
    return trigger ? { command: commandName, trigger } : undefined;
  }

  return undefined;
}

function normalizeExecutableName(command: string | undefined): string {
  if (!command) {
    return "";
  }
  return path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/u, "");
}

function unwrapEnvCommand(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } | undefined {
  const trimmedArgs = args.map((arg) => String(arg).trim()).filter((arg) => arg.length > 0);
  let index = 0;
  while (index < trimmedArgs.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(trimmedArgs[index]!)) {
    index += 1;
  }
  const forwardedCommand = trimmedArgs[index];
  if (!forwardedCommand) {
    return undefined;
  }
  return {
    command: forwardedCommand,
    args: trimmedArgs.slice(index + 1),
  };
}

function findExactArg(args: readonly string[], candidates: readonly string[]): string | undefined {
  const loweredCandidates = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return args.find((arg) => loweredCandidates.has(arg.toLowerCase()));
}

function isPythonLike(commandName: string): boolean {
  return commandName === "python" || /^python\d+(\.\d+)?$/u.test(commandName) || commandName === "pypy";
}

function findMatchingGrant(
  requirement: { readonly provider: string; readonly scopes: readonly string[] },
  grants: readonly LocalAdmissionGrant[],
): LocalAdmissionGrant | undefined {
  return grants.find(
    (grant) =>
      grant.provider === requirement.provider &&
      grant.status !== "revoked" &&
      requirement.scopes.every((scope) => grant.scopes.includes(scope)),
  );
}

function scopeAllows(grantedScope: string, requestedScope: string): boolean {
  if (grantedScope === "*" || grantedScope === requestedScope) {
    return true;
  }
  if (grantedScope.endsWith(":*")) {
    return requestedScope.startsWith(grantedScope.slice(0, -1));
  }
  return false;
}


export {
  admitSandbox,
  normalizeSandboxDeclaration,
  sandboxRequiresApproval,
  type RequiredSandboxDeclaration,
  type SandboxAdmissionDecision,
  type SandboxDeclaration,
  type SandboxProfile,
} from "./sandbox.js";
export {
  DEFAULT_PUBLIC_WORK_POLICY,
  evaluatePublicCommentOpportunity,
  evaluatePublicPullRequestCandidate,
  normalizePublicWorkPolicy,
  type PublicCommentOpportunityRequest,
  type PublicCommentPolicyDecision,
  type PublicPullRequestCandidateRequest,
  type PublicPolicyDecision,
  type PublicWorkPolicy,
} from "./public-work.js";
