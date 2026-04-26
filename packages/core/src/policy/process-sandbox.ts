import path from "node:path";

import { normalizeSandboxDeclaration, type SandboxDeclaration } from "./sandbox.js";

const defaultEnvAllowlist = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface LocalProcessSandboxOptions {
  readonly sandbox?: SandboxDeclaration & { readonly approvedEscalation?: boolean };
  readonly skillDirectory: string;
  readonly sourceCwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly writablePaths?: readonly string[];
}

export type LocalProcessSandboxResult =
  | {
      readonly status: "allow";
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "deny";
      readonly reason: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };

export function prepareLocalProcessSandbox(options: LocalProcessSandboxOptions): LocalProcessSandboxResult {
  const ambientEnv = options.env ?? process.env;
  const declaration = normalizeSandboxDeclaration(options.sandbox);
  const skillDirectory = path.resolve(options.skillDirectory);
  const workspaceRoot = path.resolve(ambientEnv.RUNX_CWD ?? ambientEnv.INIT_CWD ?? process.cwd());
  const cwd = resolveProcessCwd(skillDirectory, options.sourceCwd);
  const writablePaths = options.writablePaths ?? declaration.writablePaths;
  const baseMetadata = buildSandboxMetadata({
    declaration,
    cwd,
    workspaceRoot,
    writablePaths,
    approvedEscalation: options.sandbox?.approvedEscalation ?? false,
  });

  const cwdDenial = denyUnsafeCwd(declaration.cwdPolicy, cwd, skillDirectory, workspaceRoot, declaration.profile);
  if (cwdDenial) {
    return {
      status: "deny",
      reason: cwdDenial,
      metadata: baseMetadata,
    };
  }

  const writablePathDenial = denyUnsafeWritablePaths(declaration.profile, writablePaths, cwd, workspaceRoot);
  if (writablePathDenial) {
    return {
      status: "deny",
      reason: writablePathDenial,
      metadata: baseMetadata,
    };
  }

  return {
    status: "allow",
    cwd,
    env: buildSandboxEnv(ambientEnv, declaration.envAllowlist, declaration.profile, options.sandbox?.approvedEscalation ?? false, workspaceRoot),
    metadata: baseMetadata,
  };
}

function resolveProcessCwd(skillDirectory: string, sourceCwd: string | undefined): string {
  if (!sourceCwd) {
    return skillDirectory;
  }
  return path.isAbsolute(sourceCwd) ? path.resolve(sourceCwd) : path.resolve(skillDirectory, sourceCwd);
}

function denyUnsafeCwd(
  cwdPolicy: "skill-directory" | "workspace" | "custom",
  cwd: string,
  skillDirectory: string,
  workspaceRoot: string,
  profile: SandboxDeclaration["profile"],
): string | undefined {
  if (profile === "unrestricted-local-dev") {
    return undefined;
  }
  if (cwdPolicy === "skill-directory" && !isWithinPath(cwd, skillDirectory)) {
    return `sandbox cwd '${cwd}' is outside skill directory '${skillDirectory}'`;
  }
  if (cwdPolicy === "workspace" && !isWithinPath(cwd, workspaceRoot)) {
    return `sandbox cwd '${cwd}' is outside workspace '${workspaceRoot}'`;
  }
  return undefined;
}

function denyUnsafeWritablePaths(
  profile: SandboxDeclaration["profile"],
  writablePaths: readonly string[],
  cwd: string,
  workspaceRoot: string,
): string | undefined {
  if (profile !== "workspace-write") {
    return undefined;
  }
  const escaped = writablePaths
    .map((writablePath) => path.isAbsolute(writablePath) ? path.resolve(writablePath) : path.resolve(cwd, writablePath))
    .filter((writablePath) => !isWithinPath(writablePath, workspaceRoot));
  if (escaped.length > 0) {
    return `workspace-write sandbox has writable path(s) outside workspace: ${escaped.join(", ")}`;
  }
  return undefined;
}

function buildSandboxEnv(
  ambientEnv: NodeJS.ProcessEnv,
  explicitAllowlist: readonly string[] | undefined,
  profile: SandboxDeclaration["profile"],
  approvedEscalation: boolean,
  workspaceRoot: string,
): NodeJS.ProcessEnv {
  const allowlist = explicitAllowlist ?? (profile === "unrestricted-local-dev" && approvedEscalation ? undefined : defaultEnvAllowlist);
  const baseEnv =
    allowlist === undefined
      ? { ...ambientEnv }
      : Object.fromEntries(allowlist.filter((key) => ambientEnv[key] !== undefined).map((key) => [key, ambientEnv[key]]));

  return {
    ...baseEnv,
    RUNX_CWD: baseEnv.RUNX_CWD ?? workspaceRoot,
  };
}

function buildSandboxMetadata(options: {
  readonly declaration: ReturnType<typeof normalizeSandboxDeclaration>;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly writablePaths: readonly string[];
  readonly approvedEscalation: boolean;
}): Readonly<Record<string, unknown>> {
  const inheritedAmbient = options.declaration.envAllowlist === undefined
    && options.declaration.profile === "unrestricted-local-dev"
    && options.approvedEscalation;
  return {
    profile: options.declaration.profile,
    cwd: options.cwd,
    workspace_root: options.workspaceRoot,
    cwd_policy: options.declaration.cwdPolicy,
    env: inheritedAmbient
      ? { mode: "ambient-inherited" }
      : {
          mode: options.declaration.envAllowlist ? "allowlist" : "default-allowlist",
          allowlist: options.declaration.envAllowlist ?? defaultEnvAllowlist,
        },
    network: {
      declared: options.declaration.network,
      enforcement: "not-enforced-locally",
    },
    writable_paths: options.writablePaths,
    filesystem: {
      enforcement: "cwd-boundary-and-writable-path-admission",
    },
    approval: {
      required: options.declaration.profile === "unrestricted-local-dev",
      approved: options.approvedEscalation,
    },
  };
}

function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
