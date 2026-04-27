import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeSandboxDeclaration, type SandboxDeclaration } from "@runxhq/core/policy";

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
  readonly command?: string;
  readonly args?: readonly string[];
}

export type LocalProcessSandboxResult =
  | {
      readonly status: "allow";
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly command?: string;
      readonly args?: readonly string[];
      readonly cleanupPaths?: readonly string[];
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
  const runtime = resolveSandboxRuntime(declaration.profile, declaration.requireEnforcement, ambientEnv);
  const baseMetadata = buildSandboxMetadata({
    declaration,
    cwd,
    workspaceRoot,
    writablePaths,
    approvedEscalation: options.sandbox?.approvedEscalation ?? false,
    runtime,
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

  if (runtime.kind === "unsupported") {
    return {
      status: "deny",
      reason: runtime.reason,
      metadata: baseMetadata,
    };
  }

  const privateTmp = runtime.kind === "bubblewrap" ? mkSandboxTempDir() : undefined;
  const metadata = privateTmp
    ? buildSandboxMetadata({
        declaration,
        cwd,
        workspaceRoot,
        writablePaths,
        approvedEscalation: options.sandbox?.approvedEscalation ?? false,
        runtime,
        privateTmp,
      })
    : baseMetadata;

  const spawnPlan = runtime.kind === "bubblewrap" && options.command
    ? buildBubblewrapSpawnPlan({
      bwrapPath: runtime.path,
      command: options.command,
      args: options.args ?? [],
      cwd,
      skillDirectory,
      workspaceRoot,
      writablePaths,
      profile: declaration.profile,
      network: declaration.network,
      privateTmp: privateTmp ?? mkSandboxTempDir(),
    })
    : {
        command: options.command,
        args: options.args,
      };

  return {
    status: "allow",
    cwd,
    env: buildSandboxEnv(
      ambientEnv,
      declaration.envAllowlist,
      declaration.profile,
      options.sandbox?.approvedEscalation ?? false,
      workspaceRoot,
      privateTmp,
    ),
    command: spawnPlan.command,
    args: spawnPlan.args,
    cleanupPaths: privateTmp ? [privateTmp] : undefined,
    metadata,
  };
}

export function cleanupLocalProcessSandbox(sandbox: LocalProcessSandboxResult): void {
  if (sandbox.status !== "allow") {
    return;
  }
  cleanupPaths(sandbox.cleanupPaths ?? []);
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
  if (cwdPolicy === "custom" && !isWithinPath(cwd, skillDirectory) && !isWithinPath(cwd, workspaceRoot)) {
    return `sandbox custom cwd '${cwd}' is outside skill directory '${skillDirectory}' and workspace '${workspaceRoot}'`;
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
  privateTmp: string | undefined,
): NodeJS.ProcessEnv {
  const allowlist = explicitAllowlist ?? (profile === "unrestricted-local-dev" && approvedEscalation ? undefined : defaultEnvAllowlist);
  const baseEnv =
    allowlist === undefined
      ? { ...ambientEnv }
      : Object.fromEntries(allowlist.filter((key) => ambientEnv[key] !== undefined).map((key) => [key, ambientEnv[key]]));

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    RUNX_CWD: baseEnv.RUNX_CWD ?? workspaceRoot,
  };

  if (privateTmp) {
    env.TMPDIR = privateTmp;
    env.TMP = privateTmp;
    env.TEMP = privateTmp;
  }

  return env;
}

function buildSandboxMetadata(options: {
  readonly declaration: ReturnType<typeof normalizeSandboxDeclaration>;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly writablePaths: readonly string[];
  readonly approvedEscalation: boolean;
  readonly runtime: SandboxRuntime;
  readonly privateTmp?: string;
}): Readonly<Record<string, unknown>> {
  const inheritedAmbient = options.declaration.envAllowlist === undefined
    && options.declaration.profile === "unrestricted-local-dev"
    && options.approvedEscalation;
  const runtimeEnforcement = options.runtime.kind === "bubblewrap"
    ? {
        enforcer: "bubblewrap",
        command: options.runtime.path,
      }
    : options.runtime.kind === "direct"
      ? {
          enforcer: "direct",
        }
      : options.runtime.kind === "declared-policy-only"
        ? {
            enforcer: "declared-policy-only",
            reason: options.runtime.reason,
          }
        : {
            enforcer: "unsupported",
            reason: options.runtime.reason,
          };
  const networkEnforcement = options.runtime.kind === "bubblewrap"
    ? options.declaration.network ? "host-network-shared" : "isolated-namespace"
    : options.runtime.kind === "direct" ? "host-ambient" : options.runtime.kind === "declared-policy-only" ? "not-enforced-local" : "unsupported";
  const filesystemEnforcement = options.runtime.kind === "bubblewrap"
    ? "bubblewrap-mount-namespace"
    : options.runtime.kind === "direct" ? "host-ambient" : options.runtime.kind === "declared-policy-only" ? "not-enforced-local" : "unsupported";
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
      enforcement: networkEnforcement,
    },
    writable_paths: options.writablePaths,
    require_enforcement: options.declaration.requireEnforcement,
    filesystem: {
      enforcement: filesystemEnforcement,
      readonly_paths: options.declaration.profile !== "unrestricted-local-dev",
      writable_paths_enforced: options.runtime.kind === "bubblewrap" && options.declaration.profile === "workspace-write",
      private_tmp: options.runtime.kind === "bubblewrap" && Boolean(options.privateTmp),
    },
    approval: {
      required: options.declaration.profile === "unrestricted-local-dev",
      approved: options.approvedEscalation,
    },
    runtime: runtimeEnforcement,
  };
}

function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type SandboxRuntime =
  | {
      readonly kind: "direct";
    }
  | {
      readonly kind: "declared-policy-only";
      readonly reason: string;
    }
  | {
      readonly kind: "bubblewrap";
      readonly path: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

function resolveSandboxRuntime(
  profile: SandboxDeclaration["profile"],
  requireEnforcement: boolean,
  ambientEnv: NodeJS.ProcessEnv,
): SandboxRuntime {
  if (profile === "unrestricted-local-dev") {
    return { kind: "direct" };
  }

  if (process.platform !== "linux") {
    const reason = `local sandbox profile '${profile}' requires Linux bubblewrap support for filesystem and network enforcement`;
    return requireEnforcement || sandboxEnforcementRequiredByEnv(ambientEnv)
      ? { kind: "unsupported", reason }
      : { kind: "declared-policy-only", reason };
  }

  const bwrapPath = findExecutable("bwrap", ambientEnv.PATH);
  if (!bwrapPath) {
    const reason = `local sandbox profile '${profile}' requires bubblewrap (bwrap) for filesystem and network enforcement`;
    return requireEnforcement || sandboxEnforcementRequiredByEnv(ambientEnv)
      ? { kind: "unsupported", reason }
      : { kind: "declared-policy-only", reason };
  }

  return {
    kind: "bubblewrap",
    path: bwrapPath,
  };
}

function sandboxEnforcementRequiredByEnv(ambientEnv: NodeJS.ProcessEnv): boolean {
  return ambientEnv.RUNX_SANDBOX_REQUIRE_ENFORCEMENT === "1"
    || ambientEnv.RUNX_SANDBOX_REQUIRE_ENFORCEMENT === "true";
}

function buildBubblewrapSpawnPlan(options: {
  readonly bwrapPath: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly skillDirectory: string;
  readonly workspaceRoot: string;
  readonly writablePaths: readonly string[];
  readonly profile: SandboxDeclaration["profile"];
  readonly network: boolean;
  readonly privateTmp: string;
}): { readonly command: string; readonly args: readonly string[] } {
  const readonlyMounts = uniquePaths([
    ...systemReadonlyMounts(),
    ...defined([findPackageRoot(options.skillDirectory)]),
    options.skillDirectory,
    options.workspaceRoot,
    options.cwd,
  ]);
  const writableMounts = options.profile === "workspace-write"
    ? prepareWritableMounts(options.writablePaths, options.cwd)
    : [];
  const args: string[] = [
    "--unshare-all",
    ...(options.network ? ["--share-net"] : []),
    "--die-with-parent",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];

  for (const mountPath of readonlyMounts) {
    args.push("--ro-bind-try", mountPath, mountPath);
  }

  args.push("--bind", options.privateTmp, options.privateTmp);

  for (const mount of writableMounts) {
    args.push("--bind", mount.source, mount.destination);
  }

  args.push("--chdir", options.cwd, "--", options.command, ...options.args);
  return {
    command: options.bwrapPath,
    args,
  };
}

function systemReadonlyMounts(): readonly string[] {
  return [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/opt",
    "/nix",
    "/snap",
  ];
}

function prepareWritableMounts(
  writablePaths: readonly string[],
  cwd: string,
): readonly { readonly source: string; readonly destination: string }[] {
  return uniquePaths(writablePaths.map((writablePath) => path.isAbsolute(writablePath) ? path.resolve(writablePath) : path.resolve(cwd, writablePath)))
    .map((writablePath) => {
      if (existsSync(writablePath)) {
        const stat = statSync(writablePath);
        if (stat.isDirectory()) {
          return {
            source: writablePath,
            destination: writablePath,
          };
        }
        return {
          source: writablePath,
          destination: writablePath,
        };
      }

      mkdirSync(path.dirname(writablePath), { recursive: true });
      closeSync(openSync(writablePath, "a"));
      return {
        source: writablePath,
        destination: writablePath,
      };
    });
}

function mkSandboxTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "runx-local-sandbox-"));
}

function cleanupPaths(paths: readonly string[]): void {
  for (const cleanupPath of paths) {
    try {
      rmSync(cleanupPath, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; execution already completed or failed.
    }
  }
}

function findExecutable(command: string, searchPath: string | undefined): string | undefined {
  const pathEntries = (searchPath ?? process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  for (const candidate of [`/usr/bin/${command}`, `/bin/${command}`]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findPackageRoot(start: string): string | undefined {
  let current = path.resolve(start);
  let found: string | undefined;
  while (true) {
    if (existsSync(path.join(current, "package.json")) || existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      found = current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return found;
    }
    current = parent;
  }
}

function defined<T>(values: readonly (T | undefined)[]): readonly T[] {
  return values.filter((value): value is T => value !== undefined);
}

function uniquePaths(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    paths.push(resolved);
  }
  return paths;
}
