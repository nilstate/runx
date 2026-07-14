// overlay-open-skill-2: governance overlay over anthropics/skills/skill-creator
// Digest pinning + caller-supplied output-prefix and skill-count governance.

const WRAPS_PATH =
  "https://raw.githubusercontent.com/anthropics/skills/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/skill-creator/SKILL.md";
const PINNED_DIGEST =
  "sha256:dcd4803e61e913e6fc27294184cd3a71f09f5e924ff20c8a9a20173e7b3c2bcf";

function env(key) {
  return process.env["RUNX_INPUT_" + key.toUpperCase()];
}

function main() {
  const objective = (env("objective") || "Create a skill under governed boundaries.").trim();
  const providedDigest = env("resolved_digest");
  const resolvedDigest = providedDigest ? providedDigest.trim().toLowerCase() : null;
  const allowedOutputPrefix = env("allowed_output_prefix");
  const maxSkillsStr = env("max_skills");

  const base = {
    schema: "runx.skill_overlay.v1",
    objective,
    wraps: { path: WRAPS_PATH, digest: PINNED_DIGEST },
    resolved_digest: resolvedDigest,
    governance: {
      allowed_output_prefix: allowedOutputPrefix || null,
      max_skills: maxSkillsStr ? parseInt(maxSkillsStr, 10) : null,
    },
  };

  const diagnostics = [];

  // --- 1. Digest required ---
  if (resolvedDigest === null) {
    diagnostics.push({
      id: "runx.overlay.digest.required",
      severity: "warning",
      message: "Resolve the immutable wrapped SKILL.md and provide its recomputed sha256 digest before running.",
    });
    return emit(base, diagnostics, "needs_input");
  }

  // --- 2. Digest format check ---
  if (!/^sha256:[0-9a-f]{64}$/.test(resolvedDigest)) {
    diagnostics.push({
      id: "runx.overlay.digest.stale",
      severity: "error",
      message: "Resolved digest is malformed or does not match the pinned sha256 digest.",
    });
    return emit(base, diagnostics, "refused");
  }

  // --- 3. Digest match check ---
  if (resolvedDigest !== PINNED_DIGEST) {
    diagnostics.push({
      id: "runx.overlay.digest.stale",
      severity: "error",
      message: "Wrapped SKILL.md bytes no longer match the pinned sha256 digest; changed instructions were not admitted.",
    });
    return emit(base, diagnostics, "refused");
  }

  // --- 4. Governance parameter validation ---
  const govErrors = [];

  if (!allowedOutputPrefix || allowedOutputPrefix.trim().length === 0) {
    govErrors.push("allowed_output_prefix is required");
  }

  if (maxSkillsStr === null || maxSkillsStr === undefined || maxSkillsStr.trim().length === 0) {
    govErrors.push("max_skills is required");
  } else {
    const n = parseInt(maxSkillsStr, 10);
    if (isNaN(n) || n < 1 || n > 100) {
      govErrors.push("max_skills must be an integer between 1 and 100");
    }
  }

  if (govErrors.length > 0) {
    diagnostics.push({
      id: "runx.overlay.param.invalid",
      severity: "error",
      message: "Governance parameter validation failed: " + govErrors.join("; "),
    });
    return emit(base, diagnostics, "refused");
  }

  // --- 5. All checks pass ---
  return emit(base, diagnostics, "ready");
}

function emit(base, diagnostics, decision) {
  const output = { ...base, decision, diagnostics };
  process.stdout.write(JSON.stringify(output) + "\n");
  if (diagnostics.some(d => d.severity === "error")) {
    for (const d of diagnostics.filter(x => x.severity === "error")) {
      process.stderr.write(d.id + ": " + d.message + "\n");
    }
    process.exit(78);
  }
  process.exit(0);
}

main();
