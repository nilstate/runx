import { createHash } from "node:crypto";
import path from "node:path";

const WRAPS_PATH =
  "https://raw.githubusercontent.com/obra/superpowers/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/using-git-worktrees/SKILL.md";
const PINNED_DIGEST =
  "sha256:e2c3ec142e52868a51af246c620cd76ab648dcf27d6900d47e6ffd07159a9794";
const GATE_ID = "overlay-open-skill-1.worktree-create.approval";
const ALLOWED_TOOLS = Object.freeze([
  "git.status",
  "git.diff_name_only",
  "shell.exec",
]);
const DENIED_CAPABILITIES = Object.freeze([
  "git.commit",
  "git.push",
  "git.worktree.remove",
  "filesystem.write.outside_worktree",
  "network.access",
  "credentials.read",
  "gitignore.edit",
  "shell.chaining",
  "shell.redirection",
  "multiple_worktrees",
]);

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
}

function pathApi(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")
    ? path.win32
    : path.posix;
}

function normalizeAbsolute(value, field) {
  const raw = String(value || "").trim();
  const api = pathApi(raw);
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    throw attenuationError(
      "path.network_namespace",
      `${field} must not use a UNC or device namespace.`,
    );
  }
  if (!raw || !api.isAbsolute(raw)) {
    throw attenuationError("path.invalid", `${field} must be absolute.`);
  }
  return { api, value: api.normalize(raw) };
}

function isStrictChild(api, parent, child) {
  const relative = api.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !api.isAbsolute(relative);
}

function isDirectChild(api, parent, child) {
  if (!isStrictChild(api, parent, child)) return false;
  const relative = api.relative(parent, child);
  return !relative.includes(api.sep);
}

function attenuationError(suffix, message) {
  const error = new Error(message);
  error.diagnosticId = `runx.overlay.attenuation.${suffix}`;
  return error;
}

function diagnostic(id, message) {
  return { id, severity: "error", message };
}

function refuse(inputs, id, message) {
  const admission = {
    schema: "runx.skill_overlay.worktree_admission.v1",
    decision: "refused",
    objective: String(inputs.objective || "").trim(),
    wraps: {
      path: WRAPS_PATH,
      pinned_digest: PINNED_DIGEST,
      resolved_digest: String(inputs.resolved_digest || "").trim().toLowerCase(),
    },
    diagnostics: [diagnostic(id, message)],
    approval: { required: false, gate_id: GATE_ID },
    denied_capabilities: DENIED_CAPABILITIES,
  };
  process.stdout.write(`${JSON.stringify({ admission })}\n`);
  process.stderr.write(`${id}: ${message}\n`);
}

function main() {
  const inputs = readInputs();
  const resolvedDigest = String(inputs.resolved_digest || "").trim().toLowerCase();

  if (!/^sha256:[0-9a-f]{64}$/.test(resolvedDigest)) {
    refuse(
      inputs,
      "runx.overlay.digest.stale",
      "The resolved wrapped-skill digest is missing or malformed.",
    );
    return;
  }
  if (resolvedDigest !== PINNED_DIGEST) {
    refuse(
      inputs,
      "runx.overlay.digest.stale",
      "The wrapped SKILL.md bytes do not match the pinned digest; changed instructions were not admitted.",
    );
    return;
  }

  try {
    const objective = String(inputs.objective || "").trim();
    if (!objective) {
      throw attenuationError("objective.empty", "objective must not be empty.");
    }

    const repo = normalizeAbsolute(inputs.repo_root, "repo_root");
    const root = normalizeAbsolute(inputs.worktree_root, "worktree_root");
    const target = normalizeAbsolute(inputs.worktree_path, "worktree_path");
    if (repo.api !== root.api || repo.api !== target.api) {
      throw attenuationError("path.flavor", "All paths must use the same path flavor.");
    }
    const expectedRoot = repo.api.join(repo.value, ".worktrees");
    if (repo.api.relative(expectedRoot, root.value) !== "") {
      throw attenuationError(
        "worktree_root.name",
        "worktree_root must be exactly <repo_root>/.worktrees.",
      );
    }
    if (!isDirectChild(repo.api, root.value, target.value)) {
      throw attenuationError(
        "worktree_path.escape",
        "worktree_path must be one direct child of worktree_root.",
      );
    }

    const branchName = String(inputs.branch_name || "").trim();
    const safeBranch =
      /^(feature|fix|chore|docs|test|refactor|codex)\/[a-z0-9][a-z0-9._/-]{0,78}$/;
    const branchSegments = branchName.split("/");
    if (
      !safeBranch.test(branchName) ||
      branchName.includes("..") ||
      branchName.includes("@{") ||
      branchSegments.some(
        (segment) =>
          !segment ||
          segment.startsWith(".") ||
          segment.endsWith(".") ||
          segment.endsWith(".lock"),
      )
    ) {
      throw attenuationError(
        "branch.invalid",
        "branch_name is outside the bounded branch namespace or contains unsafe Git syntax.",
      );
    }

    const startCommit = String(inputs.start_commit || "").trim().toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(startCommit)) {
      throw attenuationError(
        "start_commit.invalid",
        "start_commit must be a full 40- or 64-hex immutable Git object id.",
      );
    }
    if (String(inputs.mechanism || "").trim() !== "git_fallback") {
      throw attenuationError(
        "mechanism.invalid",
        "mechanism must be git_fallback for this package version.",
      );
    }
    if (Number(inputs.max_worktrees) !== 1) {
      throw attenuationError(
        "worktree_count.invalid",
        "max_worktrees must be exactly 1.",
      );
    }

    const argv = [
      "git",
      "-C",
      repo.value,
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      branchName,
      target.value,
      startCommit,
    ];
    const idempotencyKey = `sha256:${createHash("sha256")
      .update(JSON.stringify(argv))
      .digest("hex")}`;
    const admission = {
      schema: "runx.skill_overlay.worktree_admission.v1",
      decision: "ready_for_approval",
      objective,
      wraps: {
        path: WRAPS_PATH,
        pinned_digest: PINNED_DIGEST,
        resolved_digest: resolvedDigest,
      },
      attenuation: {
        repo_root: repo.value,
        worktree_root: root.value,
        worktree_path: target.value,
        branch_name: branchName,
        start_commit: startCommit,
        mechanism: "git_fallback",
        max_worktrees: 1,
        argv,
        scopes: ["repo.read", "repo.worktree.create"],
        allowed_tools: ALLOWED_TOOLS,
        path_policy: {
          unc_and_device_namespaces: "denied",
          canonical_local_git_checkout_required: true,
          canonical_worktree_root_containment_required: true,
          symlink_and_junction_components: "denied",
        },
      },
      approval: { required: true, gate_id: GATE_ID },
      idempotency_key: idempotencyKey,
      denied_capabilities: DENIED_CAPABILITIES,
      diagnostics: [],
    };
    process.stdout.write(`${JSON.stringify({ admission })}\n`);
  } catch (error) {
    refuse(
      inputs,
      error.diagnosticId || "runx.overlay.attenuation.invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

main();
