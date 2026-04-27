export type SandboxProfile = "readonly" | "workspace-write" | "network" | "unrestricted-local-dev";

export interface SandboxDeclaration {
  readonly profile: SandboxProfile;
  readonly cwdPolicy?: "skill-directory" | "workspace" | "custom";
  readonly envAllowlist?: readonly string[];
  readonly network?: boolean;
  readonly writablePaths?: readonly string[];
  readonly requireEnforcement?: boolean;
}

export type SandboxAdmissionDecision =
  | {
      readonly status: "allow";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "approval_required";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "deny";
      readonly reasons: readonly string[];
    };

export function normalizeSandboxDeclaration(sandbox: SandboxDeclaration | undefined): RequiredSandboxDeclaration {
  return {
    profile: sandbox?.profile ?? "readonly",
    cwdPolicy: sandbox?.cwdPolicy ?? "skill-directory",
    envAllowlist: sandbox?.envAllowlist,
    network: sandbox?.network ?? sandbox?.profile === "network",
    writablePaths: sandbox?.writablePaths ?? [],
    requireEnforcement: sandbox?.requireEnforcement ?? false,
  };
}

export interface RequiredSandboxDeclaration {
  readonly profile: SandboxProfile;
  readonly cwdPolicy: "skill-directory" | "workspace" | "custom";
  readonly envAllowlist?: readonly string[];
  readonly network: boolean;
  readonly writablePaths: readonly string[];
  readonly requireEnforcement: boolean;
}

export function sandboxRequiresApproval(sandbox: SandboxDeclaration | undefined): boolean {
  return normalizeSandboxDeclaration(sandbox).profile === "unrestricted-local-dev";
}

export function admitSandbox(
  sandbox: SandboxDeclaration | undefined,
  options: { readonly approvedEscalation?: boolean; readonly skipEscalation?: boolean } = {},
): SandboxAdmissionDecision {
  const declaration = normalizeSandboxDeclaration(sandbox);
  const reasons: string[] = [];

  if (declaration.profile === "readonly") {
    if (declaration.writablePaths.length > 0) {
      reasons.push("readonly sandbox cannot declare writable paths");
    }
    if (declaration.network) {
      reasons.push("readonly sandbox cannot declare network access");
    }
  }

  if (declaration.profile === "workspace-write") {
    const unsafe = declaration.writablePaths.filter(isUnsafeWritablePath);
    if (unsafe.length > 0) {
      reasons.push(`workspace-write sandbox has unsafe writable path(s): ${unsafe.join(", ")}`);
    }
  }

  if (declaration.profile === "network" && declaration.writablePaths.length > 0) {
    reasons.push("network sandbox cannot declare writable paths; use unrestricted-local-dev for combined local write and network access");
  }

  if (reasons.length > 0) {
    return { status: "deny", reasons };
  }

  if (declaration.profile === "unrestricted-local-dev" && !options.approvedEscalation && !options.skipEscalation) {
    return {
      status: "approval_required",
      reasons: ["unrestricted-local-dev sandbox requires explicit caller approval"],
    };
  }

  return {
    status: "allow",
    reasons: [`sandbox profile '${declaration.profile}' admitted`],
  };
}

function isUnsafeWritablePath(value: string): boolean {
  return value.length === 0 || value.split(/[\\/]+/).includes("..");
}
