#!/usr/bin/env node
// overlay-open-skill-2 governance runner.
//
// This runner enforces the wrapper's declared bounds, attenuation, and
// approval gate. It does not copy or execute the wrapped upstream skill;
// it pins the digest, bounds the scope and allowed_tools, attenuates the
// emitted effect, and seals a receipt for every decision. The receipt
// describes exactly what the wrapper admitted, attenuated, or refused.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WRAPS_PATH =
  "https://raw.githubusercontent.com/openai/codex/main/.codex/skills/codex-bug/SKILL.md";
const PINNED_DIGEST =
  "sha256:cfdaae2defa524d9f2fb8573bb0e4961c99e2237d48666d9007e0ef5d210cbbf";
const SCOPES = Object.freeze(["repo.read"]);
const ALLOWED_TOOLS = Object.freeze(["shell.exec", "fs.read"]);
const DENIED_CAPABILITIES = Object.freeze([
  "filesystem.write.outside_allowed_output_prefix",
  "repo.commit",
  "repo.push",
  "publish",
  "secrets.read",
  "network.access.unattended",
]);
const ATTENUATION = Object.freeze({
  allowed_output_prefix: "./.runx/bug-triage/",
  max_skills: 1,
});
const APPROVAL = Object.freeze({
  gate_keywords: ["security", "compliance", "network", "credential", "secret", "publish"],
});

// Deterministic, short-lived approval tokens are seeded from the resolved
// digest + the operator objective. The runner seals the token in a
// `pending_approval` receipt; the operator who supplies the same token via
// RUNX_INPUT_APPROVAL_TOKEN clears the gate for the next invocation.
const approvalTokenFor = (resolvedDigest, objective) => {
  const seed = `${resolvedDigest}|${objective}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
};

const readInputs = () => {
  const fromPath = process.env.RUNX_INPUTS_PATH;
  const raw = fromPath
    ? fs.readFileSync(fromPath, "utf8")
    : process.env.RUNX_INPUTS_JSON || fs.readFileSync(0, "utf8") || "{}";
  return JSON.parse(raw || "{}");
};

const seal = (body) => {
  const stripped = { ...body };
  delete stripped.receipt_local;
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(stripped))
    .digest("hex");
  const out = {
    ...body,
    receipt_local: {
      schema: "runx.receipt.local.v1",
      algorithm: "sha256",
      digest,
    },
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return digest;
};

const normalizePath = (rawPath) => {
  if (!rawPath) return null;
  const trimmed = String(rawPath).trim();
  if (trimmed.length === 0) return null;
  return trimmed;
};

const pathWithinPrefix = (rawPath, prefix) => {
  if (!rawPath) return false;
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"));
  const normalizedPrefix = path.posix.normalize(prefix.replace(/\\/g, "/"));
  return (
    normalized === normalizedPrefix ||
    normalized.startsWith(`${normalizedPrefix}`)
  );
};

const checkGateKeywords = (preview) => {
  if (!preview) return { hit: false, matched: [] };
  const haystack = String(preview).toLowerCase();
  const matched = APPROVAL.gate_keywords.filter((kw) => haystack.includes(kw));
  return { hit: matched.length > 0, matched };
};

const run = async () => {
  const inputs = readInputs();
  const pick = (key) => {
    if (process.env[`RUNX_INPUT_${key.toUpperCase()}`] !== undefined) {
      return process.env[`RUNX_INPUT_${key.toUpperCase()}`];
    }
    return inputs[key];
  };
  const objective = String(
    pick("objective") ?? "Admit pinned bug-triage guidance into the read-only attenuation envelope.",
  ).trim();
  const outputPath = normalizePath(pick("output_path"));
  const nestedSkillCallsRaw = pick("nested_skill_calls");
  const nestedSkillCalls = Number.isFinite(Number(nestedSkillCallsRaw))
    ? Number(nestedSkillCallsRaw)
    : 0;
  const providedTokenRaw = pick("approval_token");
  const providedToken = providedTokenRaw
    ? String(providedTokenRaw).trim()
    : null;
  const wrappedPreviewRaw = pick("wrapped_guidance_preview");
  const wrappedPreview = wrappedPreviewRaw
    ? String(wrappedPreviewRaw)
    : null;
  const overrideDigestRaw = pick("resolved_digest");
  const overrideDigest = overrideDigestRaw
    ? String(overrideDigestRaw).trim().toLowerCase()
    : null;

  const base = {
    schema: "runx.skill_overlay.v2",
    objective,
    wraps: { path: WRAPS_PATH, digest: PINNED_DIGEST },
    resolved_digest: overrideDigest,
    runner: {
      type: "agent",
      scopes: SCOPES,
      allowed_tools: ALLOWED_TOOLS,
      denied_capabilities: DENIED_CAPABILITIES,
    },
    attenuation: {
      allowed_output_prefix: ATTENUATION.allowed_output_prefix,
      max_skills: ATTENUATION.max_skills,
      output_path_check: "passed",
      nested_skill_calls_check: "passed",
    },
    approval: {
      state: "none",
      gate_keywords: APPROVAL.gate_keywords,
      approval_token: null,
    },
  };

  const diagnostics = [];

  if (!overrideDigest) {
    seal({
      ...base,
      resolved_digest: null,
      decision: "needs_input",
      diagnostics: [
        {
          id: "runx.overlay.digest.required",
          severity: "warning",
          message:
            "Resolve the immutable wrapped SKILL.md and provide its recomputed sha256 digest before admitting the wrapped guidance.",
        },
      ],
    });
    return;
  }

  if (!/^sha256:[0-9a-f]{64}$/.test(overrideDigest)) {
    seal({
      ...base,
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.digest.stale",
          severity: "error",
          message:
            "Resolved digest is invalid or does not match the pinned sha256 digest.",
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  if (overrideDigest !== PINNED_DIGEST) {
    seal({
      ...base,
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.digest.stale",
          severity: "error",
          message:
            "Wrapped SKILL.md bytes no longer match the pinned sha256 digest; changed instructions were not admitted.",
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  if (SCOPES.length === 0) {
    seal({
      ...base,
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.scope.empty",
          severity: "error",
          message: "Overlay declares no runner scopes; refusing rather than admitting an implicit allow-all.",
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  if (ALLOWED_TOOLS.length === 0) {
    seal({
      ...base,
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.tools.unbounded",
          severity: "error",
          message: "Overlay declares no allowed_tools; refusing rather than admitting an unbounded tool set.",
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  if (outputPath !== null && !pathWithinPrefix(outputPath, ATTENUATION.allowed_output_prefix)) {
    seal({
      ...base,
      attenuation: {
        ...base.attenuation,
        output_path_check: "refused",
      },
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.attenuation.violation",
          severity: "error",
          message: `Emitted path ${JSON.stringify(outputPath)} is outside the declared allowed_output_prefix ${JSON.stringify(ATTENUATION.allowed_output_prefix)}; refusing.`,
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  if (nestedSkillCalls > ATTENUATION.max_skills) {
    seal({
      ...base,
      attenuation: {
        ...base.attenuation,
        nested_skill_calls_check: "refused",
      },
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.attenuation.violation",
          severity: "error",
          message: `nested_skill_calls=${nestedSkillCalls} exceeds declared max_skills=${ATTENUATION.max_skills}; refusing.`,
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  const gateHit = checkGateKeywords(wrappedPreview);

  if (gateHit.hit) {
    const token = approvalTokenFor(overrideDigest, objective);
    if (providedToken && providedToken === token) {
      seal({
        ...base,
        approval: {
          state: "approved",
          gate_keywords: APPROVAL.gate_keywords,
          approval_token: token,
        },
        decision: "ready",
        diagnostics: [],
      });
      return;
    }
    seal({
      ...base,
      approval: {
        state: "pending",
        gate_keywords: APPROVAL.gate_keywords,
        approval_token: token,
      },
      decision: "pending_approval",
      diagnostics: [
        {
          id: "runx.overlay.approval.required",
          severity: "warning",
          message: `Wrapped guidance names gate keyword(s) ${JSON.stringify(gateHit.matched)}; sealing pending_approval receipt and stopping.`,
        },
      ],
    });
    return;
  }

  if (providedToken) {
    seal({
      ...base,
      approval: {
        state: "rejected",
        gate_keywords: APPROVAL.gate_keywords,
        approval_token: null,
      },
      decision: "refused",
      diagnostics: [
        {
          id: "runx.overlay.approval.rejected",
          severity: "error",
          message:
            "approval_token was supplied but no approval gate was triggered by the wrapped guidance; refusing to accept a stale or unrelated token.",
        },
      ],
    });
    process.exitCode = 78;
    return;
  }

  seal({
    ...base,
    decision: "ready",
    diagnostics: [],
  });
};

run().catch((err) => {
  process.stderr.write(`overlay-open-skill-2 runner crashed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});