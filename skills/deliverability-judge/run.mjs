import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "deliverability.judge.evidence.v1";
const VERSION = "0.1.0";
const HARNESS_CASES = ["sealed_healthy_signals_continue", "contradictory_signals_escalate"];

const inputs = readInputs();
const policy = normalizePolicy(inputs.policy);
const judgment = judgeDeliverability(inputs.evidence, policy);
const evidence = buildEvidence(inputs.evidence, policy, judgment);
const report = renderReport(evidence);

writeArtifacts(inputs.output_dir, evidence, report);

process.stdout.write(`${JSON.stringify({
  verdict: judgment.verdict,
  recommendation: judgment.recommendation,
  escalation_record: judgment.escalation_record,
  evidence_json: evidence,
  report_md: report,
}, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizePolicy(raw = {}) {
  return {
    min_reputation_score: numberOr(raw.min_reputation_score, 80),
    max_bounce_pct: numberOr(raw.max_bounce_pct, 2),
    max_complaint_pct: numberOr(raw.max_complaint_pct, 0.1),
    min_inbox_placement_pct: numberOr(raw.min_inbox_placement_pct, 90),
  };
}

function judgeDeliverability(rawEvidence, policy) {
  const evidence = objectOr(rawEvidence);
  const signals = {
    postmaster_report: signal(evidence.postmaster_report, "reputation_score"),
    bounce_metrics: signal(evidence.bounce_metrics, "bounce_pct"),
    complaint_metrics: signal(evidence.complaint_metrics, "complaint_pct"),
    placement_probe: signal(evidence.placement_probe, "inbox_placement_pct"),
  };

  const blockers = [];
  for (const [name, item] of Object.entries(signals)) {
    if (!item.present) blockers.push(`${name} is required`);
    if (item.present && !item.sealed) blockers.push(`${name} is not sealed`);
    if (item.present && !item.source) blockers.push(`${name}.source is required`);
    if (item.present && !item.timestamp) blockers.push(`${name}.timestamp is required`);
    if (item.present && item.value === null) blockers.push(`${name}.${item.valueName} is required`);
  }

  const reputation = signals.postmaster_report.value;
  const bounce = signals.bounce_metrics.value;
  const complaint = signals.complaint_metrics.value;
  const placement = signals.placement_probe.value;

  if (reputation !== null && reputation < policy.min_reputation_score) {
    blockers.push(`reputation_score ${reputation} below ${policy.min_reputation_score}`);
  }
  if (bounce !== null && bounce > policy.max_bounce_pct) {
    blockers.push(`bounce_pct ${bounce} exceeds ${policy.max_bounce_pct}`);
  }
  if (complaint !== null && complaint > policy.max_complaint_pct) {
    blockers.push(`complaint_pct ${complaint} exceeds ${policy.max_complaint_pct}`);
  }
  if (placement !== null && placement < policy.min_inbox_placement_pct) {
    blockers.push(`inbox_placement_pct ${placement} below ${policy.min_inbox_placement_pct}`);
  }

  const contradictions = [];
  if (reputation !== null && reputation >= policy.min_reputation_score && bounce !== null && bounce > policy.max_bounce_pct) {
    contradictions.push("high reputation conflicts with high bounce rate");
  }
  if (reputation !== null && reputation >= policy.min_reputation_score && complaint !== null && complaint > policy.max_complaint_pct) {
    contradictions.push("high reputation conflicts with high complaint rate");
  }
  if (reputation !== null && reputation >= policy.min_reputation_score && placement !== null && placement < policy.min_inbox_placement_pct) {
    contradictions.push("high reputation conflicts with weak placement probe");
  }

  const allClear = blockers.length === 0 && contradictions.length === 0;
  if (allClear) {
    const evidenceHash = hashStable({ signals: simplifySignals(signals), policy });
    return {
      verdict: {
        state: "healthy",
        confidence_window: "high",
        reason: "all sealed deliverability signals are within policy and non-contradictory",
      },
      recommendation: {
        action: "continue",
        signal_bindings: Object.entries(signals).map(([name, item]) => ({
          signal: name,
          source: item.source,
          timestamp: item.timestamp,
          value: item.value,
        })),
        evidence_hash: evidenceHash,
      },
      escalation_record: null,
      blockers,
      contradictions,
      signals,
    };
  }

  const reasonParts = [...blockers, ...contradictions];
  return {
    verdict: {
      state: "escalate",
      confidence_window: contradictions.length > 0 ? "conflicted" : "insufficient",
      reason: reasonParts.join("; "),
    },
    recommendation: null,
    escalation_record: {
      reason: reasonParts.join("; "),
      signals: simplifySignals(signals),
    },
    blockers,
    contradictions,
    signals,
  };
}

function signal(raw, valueName) {
  const item = objectOr(raw);
  const present = raw && typeof raw === "object" && !Array.isArray(raw);
  return {
    present,
    sealed: item.sealed === true,
    source: stringOr(item.source),
    timestamp: stringOr(item.timestamp),
    valueName,
    value: numberOrNull(item[valueName]),
  };
}

function simplifySignals(signals) {
  const simplified = {};
  for (const [name, item] of Object.entries(signals)) {
    simplified[name] = {
      sealed: item.sealed,
      source: item.source,
      timestamp: item.timestamp,
      [item.valueName]: item.value,
    };
  }
  return simplified;
}

function buildEvidence(rawEvidence, policy, judgment) {
  const signals = simplifySignals(judgment.signals);
  const signalLines = Object.entries(signals).map(([name, item]) => {
    const valueName = Object.keys(item).find((key) => key.endsWith("_score") || key.endsWith("_pct"));
    return `${name} sealed=${item.sealed} source=${item.source} timestamp=${item.timestamp} ${valueName}=${item[valueName]}`;
  });

  return {
    schema: SCHEMA,
    skill: {
      name: "deliverability-judge",
      version: VERSION,
    },
    observations: [
      `verdict=${judgment.verdict.state}`,
      `confidence_window=${judgment.verdict.confidence_window}`,
      ...signalLines,
      `recommendation_action=${judgment.recommendation?.action ?? "none"}`,
      `evidence_hash=${judgment.recommendation?.evidence_hash ?? "none"}`,
      `refused_reason=${judgment.escalation_record?.reason ?? "none"}`,
      `harness cases=${HARNESS_CASES.join(", ")}`,
      "receipt id=pending post-publish dogfood receipt",
    ],
    policy,
    signals,
    verdict: judgment.verdict,
    recommendation: judgment.recommendation,
    escalation_record: judgment.escalation_record,
    dogfood: {
      package: "deliverability-judge",
      input: "evidence{postmaster_report,bounce_metrics,complaint_metrics,placement_probe} + policy",
      command: "runx skill <owner>/deliverability-judge@0.1.0 --json",
      receipt_ref: null,
      verify_verdict: null,
      harness_cases: HARNESS_CASES.map((name) => ({ name, expected_status: "sealed" })),
    },
    effect_boundary: "read-only verdict; live throttle is a separate governed run dispatched by naming",
  };
}

function renderReport(evidence) {
  return [
    "# Deliverability Judge Report",
    "",
    `- Package: deliverability-judge@${VERSION}`,
    `- Verdict: ${evidence.verdict.state}`,
    `- Confidence window: ${evidence.verdict.confidence_window}`,
    `- Reason: ${evidence.verdict.reason}`,
    `- Recommendation action: ${evidence.recommendation?.action ?? "none"}`,
    `- Evidence hash: ${evidence.recommendation?.evidence_hash ?? "none"}`,
    `- Postmaster source: ${evidence.signals.postmaster_report.source}`,
    `- Bounce source: ${evidence.signals.bounce_metrics.source}`,
    `- Complaint source: ${evidence.signals.complaint_metrics.source}`,
    `- Placement source: ${evidence.signals.placement_probe.source}`,
    `- Refusal reason: ${evidence.escalation_record?.reason ?? "none"}`,
    `- Harness cases: ${HARNESS_CASES.join(" and ")}`,
    "- Effect boundary: read-only recommendation only; no send, throttle, mutation, state, or authority mint.",
    "",
  ].join("\n");
}

function writeArtifacts(outputDir, evidence, report) {
  if (typeof outputDir !== "string" || outputDir.length === 0) return;
  const root = process.cwd();
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function hashStable(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectOr(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOr(value) {
  return typeof value === "string" ? value : "";
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}
