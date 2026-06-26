import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "deliverability.judge.result.v1";

const inputs = readInputs();
const skillRoot = process.cwd();

const evidence = inputs.evidence;
const policy = inputs.policy;

if (!evidence || typeof evidence !== "object") {
  throw new Error("evidence input is required");
}
if (!policy || typeof policy !== "object") {
  throw new Error("policy input is required");
}

const SIGNAL_NAMES = ["postmaster_report", "bounce_metrics", "complaint_metrics", "placement_probe"];

// Validate signals
const signalEvaluations = {};
const missing = [];
const contradictions = [];

for (const name of SIGNAL_NAMES) {
  const sig = evidence[name];
  if (!sig || typeof sig !== "object") {
    missing.push(name);
    signalEvaluations[name] = { sealed: false, within_policy: false, value: null, threshold: null, error: "missing" };
    continue;
  }
  if (typeof sig.source !== "string" || sig.source.length === 0) {
    missing.push(name);
    signalEvaluations[name] = { sealed: false, within_policy: false, value: null, threshold: null, error: "missing_source" };
    continue;
  }
  if (typeof sig.timestamp !== "string" || sig.timestamp.length === 0) {
    missing.push(name);
    signalEvaluations[name] = { sealed: false, within_policy: false, value: null, threshold: null, error: "missing_timestamp" };
    continue;
  }

  signalEvaluations[name] = { sealed: true, source: sig.source, timestamp: sig.timestamp };
}

// Extract numeric values for sealed signals
const repScore = signalEvaluations.postmaster_report?.sealed ? evidence.postmaster_report.reputation_score : null;
const bouncePct = signalEvaluations.bounce_metrics?.sealed ? evidence.bounce_metrics.bounce_pct : null;
const complaintPct = signalEvaluations.complaint_metrics?.sealed ? evidence.complaint_metrics.complaint_pct : null;
const inboxPct = signalEvaluations.placement_probe?.sealed ? evidence.placement_probe.inbox_pct : null;

const minRep = policy.min_reputation_score;
const maxBounce = policy.max_bounce_pct;
const maxComplaint = policy.max_complaint_pct;

// Evaluate policy compliance for each sealed signal
if (signalEvaluations.postmaster_report?.sealed) {
  const within = typeof repScore === "number" && repScore >= minRep;
  signalEvaluations.postmaster_report.within_policy = within;
  signalEvaluations.postmaster_report.value = repScore;
  signalEvaluations.postmaster_report.threshold = minRep;
}
if (signalEvaluations.bounce_metrics?.sealed) {
  const within = typeof bouncePct === "number" && bouncePct <= maxBounce;
  signalEvaluations.bounce_metrics.within_policy = within;
  signalEvaluations.bounce_metrics.value = bouncePct;
  signalEvaluations.bounce_metrics.threshold = maxBounce;
}
if (signalEvaluations.complaint_metrics?.sealed) {
  const within = typeof complaintPct === "number" && complaintPct <= maxComplaint;
  signalEvaluations.complaint_metrics.within_policy = within;
  signalEvaluations.complaint_metrics.value = complaintPct;
  signalEvaluations.complaint_metrics.threshold = maxComplaint;
}
if (signalEvaluations.placement_probe?.sealed) {
  signalEvaluations.placement_probe.within_policy = typeof inboxPct === "number" && inboxPct >= 90;
  signalEvaluations.placement_probe.value = inboxPct;
}

// Contradiction detection:
// High reputation (at or above threshold) paired with high bounce (above threshold) = contradiction.
// High reputation paired with high complaint = contradiction.
const allSealed = missing.length === 0;
const repHealthy = signalEvaluations.postmaster_report?.within_policy === true;
const bounceBad = signalEvaluations.bounce_metrics?.sealed && typeof bouncePct === "number" && bouncePct > maxBounce;
const complaintBad = signalEvaluations.complaint_metrics?.sealed && typeof complaintPct === "number" && complaintPct > maxComplaint;

if (repHealthy && bounceBad) {
  contradictions.push({
    signals: ["postmaster_report", "bounce_metrics"],
    reason: `Reputation score ${repScore} is at or above threshold ${minRep}, but bounce rate ${bouncePct}% exceeds threshold ${maxBounce}%.`,
  });
}
if (repHealthy && complaintBad) {
  contradictions.push({
    signals: ["postmaster_report", "complaint_metrics"],
    reason: `Reputation score ${repScore} is at or above threshold ${minRep}, but complaint rate ${complaintPct}% exceeds threshold ${maxComplaint}%.`,
  });
}

// Determine verdict
let verdict;
let recommendation = null;
let refusalReason = null;
let runxStatus = "sealed"; // default for harness

if (!allSealed) {
  verdict = { state: "refused", confidence_window: null, reason: "Missing or unsealed signals." };
  refusalReason = `Missing signals: ${missing.join(", ")}`;
  runxStatus = "needs_agent";
} else if (contradictions.length > 0) {
  verdict = { state: "refused", confidence_window: null, reason: "Contradictory signals prevent a confident verdict." };
  refusalReason = contradictions.map((c) => c.reason).join(" ");
  runxStatus = "needs_agent";
} else {
  // All sealed, no contradictions — produce verdict
  const allWithinPolicy =
    signalEvaluations.postmaster_report.within_policy &&
    signalEvaluations.bounce_metrics.within_policy &&
    signalEvaluations.complaint_metrics.within_policy &&
    signalEvaluations.placement_probe.within_policy;

  if (allWithinPolicy) {
    verdict = {
      state: "healthy",
      confidence_window: "7d",
      reason: "All signals sealed, within policy thresholds, and non-contradictory.",
    };
    const evidenceHash = sha256(JSON.stringify(evidence));
    recommendation = {
      action: "continue",
      signal_bindings: SIGNAL_NAMES.map((name) => ({
        signal: name,
        source: evidence[name].source,
        timestamp: evidence[name].timestamp,
        within_policy: signalEvaluations[name].within_policy,
      })),
      evidence_hash: `sha256:${evidenceHash}`,
    };
  } else {
    // Some signals out of policy but not contradictory — degraded
    const outOfPolicy = SIGNAL_NAMES.filter(
      (name) => signalEvaluations[name].sealed && !signalEvaluations[name].within_policy,
    );
    verdict = {
      state: "degraded",
      confidence_window: "7d",
      reason: `Signals sealed and non-contradictory, but ${outOfPolicy.join(", ")} ${outOfPolicy.length === 1 ? "is" : "are"} outside policy thresholds.`,
    };
    const evidenceHash = sha256(JSON.stringify(evidence));
    recommendation = {
      action: outOfPolicy.length >= 2 ? "pause" : "throttle",
      signal_bindings: SIGNAL_NAMES.map((name) => ({
        signal: name,
        source: evidence[name].source,
        timestamp: evidence[name].timestamp,
        within_policy: signalEvaluations[name].within_policy,
      })),
      evidence_hash: `sha256:${evidenceHash}`,
    };
  }
}

// Build result
const result = {
  schema: SCHEMA,
  status: runxStatus,
  data: {
    verdict,
    signals: signalEvaluations,
    recommendation,
    contradictions,
    missing_signals: missing,
    refusal_reason: refusalReason,
    validation: {
      valid: allSealed && contradictions.length === 0,
      every_signal_sealed: allSealed,
      every_signal_has_source: SIGNAL_NAMES.every(
        (n) => signalEvaluations[n]?.sealed && typeof evidence[n]?.source === "string",
      ),
      every_signal_has_timestamp: SIGNAL_NAMES.every(
        (n) => signalEvaluations[n]?.sealed && typeof evidence[n]?.timestamp === "string",
      ),
      no_contradictions: contradictions.length === 0,
      no_invented_signals: SIGNAL_NAMES.every((n) => n in signalEvaluations),
    },
  },
};

// Write artifacts
const report = renderReport(result);
writeArtifacts(inputs.output_dir, result, report, skillRoot);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// Exit with non-zero for refused verdicts so the harness sees "failure" status
if (runxStatus === "needs_agent") {
  process.exit(1);
}

// --- Functions ---

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function renderReport(packet) {
  const d = packet.data;
  const lines = [];
  lines.push("# Deliverability Judge Report");
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`- **State:** ${d.verdict.state}`);
  if (d.verdict.confidence_window) {
    lines.push(`- **Confidence window:** ${d.verdict.confidence_window}`);
  }
  lines.push(`- **Reason:** ${d.verdict.reason}`);
  lines.push("");
  lines.push("## Signal Evaluations");
  lines.push("");
  lines.push("| Signal | Sealed | Source | Within Policy | Value | Threshold |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const name of SIGNAL_NAMES) {
    const s = d.signals[name];
    lines.push(
      `| ${name} | ${s.sealed ? "yes" : "no"} | ${s.source || "—"} | ${s.within_policy ? "yes" : "no"} | ${s.value ?? "—"} | ${s.threshold ?? "—"} |`,
    );
  }
  lines.push("");

  if (d.recommendation) {
    lines.push("## Recommendation");
    lines.push("");
    lines.push(`- **Action:** ${d.recommendation.action}`);
    lines.push(`- **Evidence hash:** \`${d.recommendation.evidence_hash}\``);
    lines.push("");
  }

  if (d.contradictions.length > 0) {
    lines.push("## Contradictions");
    lines.push("");
    for (const c of d.contradictions) {
      lines.push(`- ${c.reason}`);
    }
    lines.push("");
  }

  if (d.missing_signals.length > 0) {
    lines.push("## Missing Signals");
    lines.push("");
    for (const m of d.missing_signals) {
      lines.push(`- ${m}`);
    }
    lines.push("");
  }

  if (d.refusal_reason) {
    lines.push("## Refusal");
    lines.push("");
    lines.push(d.refusal_reason);
    lines.push("");
  }

  lines.push("## Reproducibility Controls");
  lines.push("");
  lines.push("- Every signal evaluation is grounded in sealed evidence with source and timestamp.");
  lines.push("- Contradictory signals are refused, not resolved into a false verdict.");
  lines.push("- No signals are invented; only the four declared signals are evaluated.");
  lines.push("- The recommendation is read-only; no authority is minted and no state is held.");
  lines.push("- The evidence hash binds the recommendation to the exact input evidence.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function writeArtifacts(outputDir, evidence_data, report, root) {
  if (!outputDir) {
    evidence_data.data.artifacts = {};
    return;
  }
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  const evidencePath = path.join(resolved, "evidence.json");
  const reportPath = path.join(resolved, "report.md");
  evidence_data.data.artifacts = {
    evidence_json: path.relative(root, evidencePath),
    report_md: path.relative(root, reportPath),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence_data, null, 2)}\n`);
  fs.writeFileSync(reportPath, report);
}

function ensureInside(root, resolved, label) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
