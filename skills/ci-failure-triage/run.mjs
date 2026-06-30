import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const SCHEMA = "runx.ci.triage.v1";
export const VERSION = "0.1.0";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const inputs = readInputs();
  const packet = triage(inputs);
  writeArtifacts(inputs.output_dir, packet);
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

export function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

export function triage(inputs) {
  const ciFailure = normalizeCiFailure(inputs.ci_failure);
  const repoConfig = normalizeRepoConfig(inputs.repo_config);
  const policy = normalizePolicy(inputs.escalation_policy);
  const evidenceRefs = extractEvidence(ciFailure);
  const signals = classifySignals(ciFailure, repoConfig);
  const classification = decide(signals, evidenceRefs, policy);

  return {
    schema: SCHEMA,
    version: VERSION,
    status: classification.status,
    classification: {
      verdict: classification.verdict,
      confidence: classification.confidence,
      evidence_refs: evidenceRefs,
    },
    triage_packet: {
      schema: SCHEMA,
      status: classification.status,
      classification: {
        verdict: classification.verdict,
        confidence: classification.confidence,
        evidence_refs: evidenceRefs,
      },
      rerun_verdict: classification.rerun_verdict,
      page_note: classification.page_note,
      routing_decision: classification.routing_decision,
      escalation: classification.escalation,
      handoff: {
        dispatch_by_naming: true,
        downstream_lanes: ["issue-intake", "issue-to-pr", "pr-review-note"],
        commencement_gate: "issue-intake",
        effect_posture: "read-only draft routing decision",
      },
    },
    policy: {
      min_confidence: policy.min_confidence,
      no_tracking_item_opened: true,
      no_ci_rerun_executed: true,
      no_operator_paged: true,
      no_authority_minted: true,
    },
    observations: [
      `classification verdict: ${classification.verdict}`,
      `classification confidence: ${classification.confidence.toFixed(2)}`,
      `recommended lane: ${classification.routing_decision?.recommended_lane || "none"}`,
      `escalation reason: ${classification.escalation?.reason || "none"}`,
      `evidence refs: ${evidenceRefs.map((ref) => ref.id).join(", ")}`,
    ],
    input_digest: sha256(JSON.stringify({ ci_failure: ciFailure, repo_config: repoConfig, escalation_policy: policy })),
  };
}

function normalizeCiFailure(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    logs: String(source.logs || ""),
    commit: String(source.commit || ""),
    repo_state: source.repo_state && typeof source.repo_state === "object" ? source.repo_state : {},
  };
}

function normalizeRepoConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    default_branch: String(source.default_branch || "main"),
    protected_paths: Array.isArray(source.protected_paths) ? source.protected_paths.map(String) : [],
    test_command: String(source.test_command || ""),
  };
}

function normalizePolicy(value) {
  const source = value && typeof value === "object" ? value : {};
  const min = Number(source.min_confidence ?? 0.75);
  return {
    min_confidence: Number.isFinite(min) ? Math.min(0.99, Math.max(0.5, min)) : 0.75,
  };
}

function extractEvidence(ciFailure) {
  const lines = ciFailure.logs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 12).map((line, index) => ({
    id: `log:${index + 1}`,
    quote: line.slice(0, 220),
  }));
}

function classifySignals(ciFailure) {
  const logs = ciFailure.logs.toLowerCase();
  const truncated = /\btruncated\b|\.\.\.$|<snip>|output limit/i.test(ciFailure.logs);
  const realBreakMatches = [
    /typeerror:/i,
    /referenceerror:/i,
    /assertionerror/i,
    /test(s)? failed/i,
    /expected .* received/i,
    /cannot find module/i,
  ].filter((pattern) => pattern.test(ciFailure.logs)).length;
  const depMatches = [
    /npm err!/i,
    /dependency/i,
    /lockfile/i,
    /peer dep/i,
    /package not found/i,
  ].filter((pattern) => pattern.test(ciFailure.logs)).length;
  const infraMatches = [
    /timeout/i,
    /connection reset/i,
    /econnreset/i,
    /rate limit/i,
    /runner lost/i,
    /network/i,
  ].filter((pattern) => pattern.test(ciFailure.logs)).length;
  const flakeMatches = [
    /flaky/i,
    /rerun passed/i,
    /intermittent/i,
    /random seed/i,
  ].filter((pattern) => pattern.test(ciFailure.logs)).length;

  return {
    truncated,
    hasLogs: logs.trim().length >= 80,
    realBreakMatches,
    depMatches,
    infraMatches,
    flakeMatches,
  };
}

function decide(signals, evidenceRefs, policy) {
  if (!signals.hasLogs || signals.truncated || evidenceRefs.length < 2) {
    return needsAgent("Logs are missing, truncated, or too thin to ground a CI verdict.");
  }

  const candidates = [
    { verdict: "real-break", score: signals.realBreakMatches, lane: "issue-to-pr", rationale: "clear code/test failure visible in logs" },
    { verdict: "dep", score: signals.depMatches, lane: "issue-to-pr", rationale: "dependency or lockfile failure visible in logs" },
    { verdict: "infra", score: signals.infraMatches, page: "operator-page-note", rationale: "runner or network infrastructure failure visible in logs" },
    { verdict: "flake", score: signals.flakeMatches, rerun: "read-only-rerun-verdict", rationale: "intermittent or rerun evidence visible in logs" },
  ].sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return needsAgent("No grounded failure class is visible in the supplied logs.");
  }

  const second = candidates[1];
  if (second && second.score > 0 && best.score - second.score <= 2) {
    return needsAgent(`Conflicting signals for ${best.verdict} and ${second.verdict}; human triage required.`);
  }

  const confidence = Math.min(0.95, 0.62 + best.score * 0.13 + Math.min(evidenceRefs.length, 6) * 0.02);
  if (confidence < policy.min_confidence) {
    return needsAgent(`Grounded confidence ${confidence.toFixed(2)} is below min_confidence ${policy.min_confidence.toFixed(2)}.`);
  }

  return {
    status: "sealed",
    verdict: best.verdict,
    confidence,
    rerun_verdict: best.rerun ? { kind: best.rerun, allowed: false, rationale: best.rationale } : null,
    page_note: best.page ? { kind: best.page, message: best.rationale, read_only: true } : null,
    routing_decision: best.lane ? { recommended_lane: best.lane, rationale: best.rationale } : null,
    escalation: null,
  };
}

function needsAgent(reason) {
  return {
    status: "needs_agent",
    verdict: "unknown",
    confidence: 0,
    rerun_verdict: null,
    page_note: null,
    routing_decision: null,
    escalation: { lane: "human", reason },
  };
}

function writeArtifacts(outputDir, packet) {
  if (!outputDir) return;
  const root = process.cwd();
  const target = path.resolve(root, outputDir);
  ensureInside(root, target);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "triage-packet.json"), `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(path.join(target, "report.md"), renderReport(packet));
}

function renderReport(packet) {
  return [
    "# CI Failure Triage Report",
    "",
    `- Status: ${packet.status}`,
    `- Verdict: ${packet.classification.verdict}`,
    `- Confidence: ${packet.classification.confidence.toFixed(2)}`,
    `- Recommended lane: ${packet.triage_packet.routing_decision?.recommended_lane || "none"}`,
    `- Escalation: ${packet.triage_packet.escalation?.reason || "none"}`,
    "",
    "## Evidence",
    "",
    ...packet.classification.evidence_refs.map((ref) => `- ${ref.id}: ${ref.quote}`),
    "",
  ].join("\n");
}

function ensureInside(root, target) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(normalizedRoot)) {
    throw new Error("output_dir must stay inside the skill directory");
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
