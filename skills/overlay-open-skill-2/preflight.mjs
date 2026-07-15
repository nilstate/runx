import { createHash } from "node:crypto";

const WRAPS_PATH =
  "https://raw.githubusercontent.com/vercel-labs/skills/5527c09adc367612b0bffd9c80e3bc28a6b01b6d/skills/find-skills/SKILL.md";
const PINNED_DIGEST =
  "sha256:c00eeea0e13e74fe4a9d84ba0a8542205a1b736d65f13134fe1a6647eb14976f";
const GATE_ID = "overlay-open-skill-2.skill-search.approval";
const ALLOWED_TOOLS = Object.freeze(["shell.exec"]);
const SCOPES = Object.freeze(["web.read", "skill.discovery"]);
const DENIED_CAPABILITIES = Object.freeze([
  "skills.add",
  "skills.install",
  "skills.update",
  "filesystem.write",
  "credentials.read",
  "unbounded_owner_search",
  "shell.chaining",
  "shell.redirection",
  "interactive_prompt",
  "additional_commands",
]);

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
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
    schema: "runx.skill_overlay.skill_search_admission.v1",
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
    if (String(inputs.operation || "").trim() !== "find") {
      throw attenuationError(
        "operation.denied",
        "operation must be find; installation and updates are outside this overlay.",
      );
    }
    if (inputs.allow_install !== false) {
      throw attenuationError(
        "install.denied",
        "allow_install must be false; this overlay grants discovery only.",
      );
    }

    const owner = String(inputs.owner || "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner)) {
      throw attenuationError(
        "owner.invalid",
        "owner must be one bounded public repository-owner name.",
      );
    }

    const query = String(inputs.query || "").trim();
    const queryTokens = query ? query.split(/\s+/) : [];
    if (
      queryTokens.length < 1 ||
      queryTokens.length > 6 ||
      queryTokens.some((token) => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(token))
    ) {
      throw attenuationError(
        "query.invalid",
        "query must contain one to six safe tokens without shell syntax.",
      );
    }

    const maxResults = Number(inputs.max_results);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
      throw attenuationError(
        "result_cap.invalid",
        "max_results must be an integer from 1 through 10.",
      );
    }

    const argv = [
      "npx",
      "--yes",
      "skills",
      "find",
      ...queryTokens,
      "--owner",
      owner,
    ];
    const idempotencyKey = `sha256:${createHash("sha256")
      .update(JSON.stringify(argv))
      .digest("hex")}`;
    const admission = {
      schema: "runx.skill_overlay.skill_search_admission.v1",
      decision: "ready_for_approval",
      objective,
      wraps: {
        path: WRAPS_PATH,
        pinned_digest: PINNED_DIGEST,
        resolved_digest: resolvedDigest,
      },
      attenuation: {
        operation: "find",
        owner,
        query_tokens: queryTokens,
        max_results: maxResults,
        allow_install: false,
        argv,
        scopes: SCOPES,
        allowed_tools: ALLOWED_TOOLS,
        execution_policy: {
          shell_interpreter: "denied",
          interactive_prompt: "denied",
          output_redaction_required: true,
          normalized_result_cap_required: true,
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
