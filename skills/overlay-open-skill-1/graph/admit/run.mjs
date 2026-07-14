const WRAPS_PATH =
  "https://raw.githubusercontent.com/anthropics/skills/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/webapp-testing/SKILL.md";
const PINNED_DIGEST =
  "sha256:51b7349e77ec63b7744a6f63647e7566a0b4d2e301121cc10e8c2113af6556a2";
const DECLARED_SCOPES = Object.freeze([
  "fs.read",
  "process.spawn",
  "browser.navigate",
  "browser.inspect",
  "browser.screenshot",
  "browser.console",
  "browser.act",
]);
const READ_ONLY_TOOLS = Object.freeze([
  "fs.read",
  "process.spawn",
  "browser.navigate",
  "browser.inspect",
  "browser.screenshot",
  "browser.console",
]);

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
}

function exactOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function refuse(packet, id, message) {
  const admissionCheck = {
    ...packet,
    decision: "refused",
    diagnostics: [{ id, severity: "error", message }],
  };
  process.stdout.write(`${JSON.stringify({ admission_check: admissionCheck })}\n`);
  process.exit(0);
}

const inputs = readInputs();
const objective = String(
  inputs.objective || "Test one local web application under governed browser boundaries.",
).trim();
const resolvedDigest = typeof inputs.resolved_digest === "string"
  ? inputs.resolved_digest.trim().toLowerCase()
  : null;
const allowedOrigin = exactOrigin(inputs.allowed_origin);
const actionBudget = Number(inputs.max_browser_actions);
const interactionMode = String(inputs.interaction_mode || "read_only").trim().toLowerCase();
const effectiveAllowedTools = interactionMode === "interactive"
  ? [...READ_ONLY_TOOLS, "browser.act"]
  : [...READ_ONLY_TOOLS];

const packet = {
  schema: "runx.skill_overlay.admission.v1",
  objective,
  wraps: { path: WRAPS_PATH, digest: PINNED_DIGEST },
  resolved_digest: resolvedDigest,
  governance: {
    allowed_origin: allowedOrigin,
    max_browser_actions: Number.isInteger(actionBudget) ? actionBudget : null,
    interaction_mode: interactionMode,
    declared_scopes: [...DECLARED_SCOPES],
    effective_allowed_tools: effectiveAllowedTools,
    denied_tools: ["fs.write", "shell.exec", "credential.read", "network.external", "task.spawn"],
  },
};

if (resolvedDigest === null) {
  refuse(
    packet,
    "runx.overlay.digest.required",
    "Resolve the immutable wrapped SKILL.md and provide its recomputed sha256 digest.",
  );
}
if (!/^sha256:[0-9a-f]{64}$/.test(resolvedDigest) || resolvedDigest !== PINNED_DIGEST) {
  refuse(
    packet,
    "runx.overlay.digest.stale",
    "Wrapped SKILL.md bytes do not match the reviewed pin; changed instructions were not admitted.",
  );
}
if (allowedOrigin === null) {
  refuse(
    packet,
    "runx.overlay.param.invalid",
    "allowed_origin must be one exact HTTP(S) origin without credentials, path, query, or fragment.",
  );
}
if (!Number.isInteger(actionBudget) || actionBudget < 1 || actionBudget > 100) {
  refuse(
    packet,
    "runx.overlay.param.invalid",
    "max_browser_actions must be an integer from 1 through 100.",
  );
}
if (!["read_only", "interactive"].includes(interactionMode)) {
  refuse(
    packet,
    "runx.overlay.param.invalid",
    "interaction_mode must be read_only or interactive.",
  );
}

process.stdout.write(`${JSON.stringify({
  admission_check: {
    ...packet,
    decision: "ready_for_approval",
    diagnostics: [],
  },
})}\n`);
