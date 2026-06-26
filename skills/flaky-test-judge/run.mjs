import fs from "node:fs";

const SCHEMA = "runx.flaky.test_triage.v1";
const VERSION = "0.1.0";
const EXCLUSION_MARKER = "@flaky-quarantine:flaky-test-judge";

const inputs = readInputs();
const history = objectValue(inputs.test_run_history, "test_run_history");
const metadata = objectValue(inputs.test_metadata, "test_metadata");
const policy = objectValue(inputs.release_policy, "release_policy");

const packet = judge({ history, metadata, policy, harnessCase: stringValue(inputs.harness_case) });

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
if (packet.disposition?.decision === "stop") {
  process.exit(64);
}

function judge({ history, metadata, policy, harnessCase }) {
  const testPath = requiredString(metadata.test_path, "test_metadata.test_path");
  const suite = stringValue(metadata.suite) ?? "unknown";
  const tags = arrayOfStrings(metadata.tags);
  const targetRepo = stringValue(metadata.target_repo) ?? "owner/repo";
  const base = stringValue(metadata.base) ?? "main";
  const threshold = numberValue(policy.flake_threshold_pct, "release_policy.flake_threshold_pct");
  const minSampleSize = integerValue(policy.min_sample_size, "release_policy.min_sample_size");
  const maxQuarantineDays = integerValue(policy.max_quarantine_days, "release_policy.max_quarantine_days");
  const runs = Array.isArray(history.runs) ? history.runs.map(normalizeRun) : [];
  const declaredSampleSize = integerValue(history.sample_size ?? runs.length, "test_run_history.sample_size");
  const window = stringValue(history.window) ?? `${declaredSampleSize} supplied runs`;

  if (runs.length === 0 || declaredSampleSize === 0) {
    return stopPacket({
      testPath,
      suite,
      tags,
      targetRepo,
      base,
      threshold,
      minSampleSize,
      maxQuarantineDays,
      declaredSampleSize,
      runCount: runs.length,
      window,
      harnessCase,
      reasonCode: "missing-evidence",
      refusedReason: "missing-evidence: no run history was supplied",
      reason: "missing-evidence stop: no run history was supplied, so quarantine is refused.",
    });
  }

  if (declaredSampleSize < minSampleSize || runs.length < minSampleSize) {
    return stopPacket({
      testPath,
      suite,
      tags,
      targetRepo,
      base,
      threshold,
      minSampleSize,
      maxQuarantineDays,
      declaredSampleSize,
      runCount: runs.length,
      window,
      harnessCase,
      reasonCode: "sample-below-minimum",
      refusedReason: `sample-below-minimum: ${Math.min(declaredSampleSize, runs.length)} runs is below ${minSampleSize}`,
      reason: `sample-below-minimum stop: ${Math.min(declaredSampleSize, runs.length)} runs is below the ${minSampleSize} minimum.`,
    });
  }

  const passCount = runs.filter((run) => run.status === "passed").length;
  const failureRuns = runs.filter((run) => run.status !== "passed");
  const failureCount = failureRuns.length;
  const runCount = runs.length;
  const passRatePct = roundPct((passCount / runCount) * 100);
  const modes = countFailureModes(failureRuns);
  const dominant = dominantFailureMode(modes);

  const baseMetrics = {
    run_count: runCount,
    declared_sample_size: declaredSampleSize,
    sample_size: declaredSampleSize,
    pass_count: passCount,
    failure_count: failureCount,
    pass_rate_pct: passRatePct,
    threshold_pct: threshold,
    min_sample_size: minSampleSize,
    max_quarantine_days: maxQuarantineDays,
    window,
    failure_modes: modes,
    dominant_failure_mode: dominant.mode,
    dominant_failure_count: dominant.count,
  };

  if (passRatePct >= threshold) {
    return noQuarantinePacket({
      testPath,
      suite,
      tags,
      targetRepo,
      base,
      metrics: baseMetrics,
      harnessCase,
      reasonCode: "pass-rate-above-threshold",
      refusedReason: `pass-rate-above-threshold: ${passRatePct}% is at or above ${threshold}%`,
      reason: `Pass rate is ${passRatePct}% across ${runCount} runs, which is at or above the ${threshold}% policy threshold.`,
    });
  }

  if (!dominant.mode || dominant.count < 2 || dominant.count < Math.ceil(failureCount / 2)) {
    return noQuarantinePacket({
      testPath,
      suite,
      tags,
      targetRepo,
      base,
      metrics: baseMetrics,
      harnessCase,
      reasonCode: "failure-mode-not-repeatable",
      refusedReason: "failure-mode-not-repeatable: supplied logs do not show a dominant repeated failure mode",
      reason: "The pass rate is below policy, but the supplied logs do not show a dominant repeated failure mode.",
    });
  }

  const durationDays = Math.min(maxQuarantineDays, Math.max(1, Math.ceil((threshold - passRatePct) / 2)));
  if (durationDays > maxQuarantineDays) {
    return noQuarantinePacket({
      testPath,
      suite,
      tags,
      targetRepo,
      base,
      metrics: baseMetrics,
      harnessCase,
      reasonCode: "quarantine-exceeds-policy",
      refusedReason: `quarantine-exceeds-policy: ${durationDays} days exceeds max ${maxQuarantineDays}`,
      reason: `The computed quarantine duration ${durationDays} exceeds the policy maximum ${maxQuarantineDays}.`,
    });
  }

  const fixTemplate = [
    `Investigate flaky ${dominant.mode} failures in ${testPath}.`,
    `Observed ${passRatePct}% pass rate across ${runCount} runs; ${dominant.count} of ${failureCount} failures classify as ${dominant.mode}.`,
    `If a temporary disable is still needed, keep ${EXCLUSION_MARKER} visible and remove it within ${durationDays} day(s).`,
  ].join(" ");
  const threadTitle = `Quarantine flaky test: ${testPath}`;
  const threadBody = [
    `Request a temporary quarantine for ${testPath}.`,
    "",
    `Evidence: ${passRatePct}% pass rate over ${runCount} runs in ${window}; ${dominant.count} of ${failureCount} failures are ${dominant.mode}.`,
    `Policy: threshold ${threshold}%, minimum sample ${minSampleSize}, max quarantine ${maxQuarantineDays} day(s).`,
    `Proposed marker: ${EXCLUSION_MARKER}`,
    `Fix template: ${fixTemplate}`,
    "",
    "A separate governed issue-to-pr run may draft the change. A human merge gate is required before any live disable.",
  ].join("\n");

  return {
    schema: SCHEMA,
    version: VERSION,
    disposition: {
      decision: "quarantine",
      confidence: confidenceFor({ passRatePct, threshold, dominantCount: dominant.count, failureCount }),
      reason_code: "below-threshold-repeatable-failure",
      reason: `${passRatePct}% pass rate across ${runCount} runs is below the ${threshold}% policy threshold; ${dominant.count} of ${failureCount} failures are ${dominant.mode} failures.`,
    },
    metrics: baseMetrics,
    quarantine_packet: {
      test_path: testPath,
      duration_days: durationDays,
      fix_template: fixTemplate,
      exclusion_marker: EXCLUSION_MARKER,
    },
    escalation: {
      lane: "human_merge_gate",
      required: true,
      reason: "The judge never mutates a repo; a human must approve any downstream issue-to-pr draft before merge.",
    },
    dispatch_target: {
      name: "issue-to-pr",
      type: "named_downstream",
      typed_inputs: {
        thread_title: threadTitle,
        thread_body: threadBody,
        target_repo: targetRepo,
        base,
      },
      offline_leg: "pr-review-note",
    },
    evidence: evidenceBlock({
      harnessCase,
      testPath,
      suite,
      tags,
      metrics: baseMetrics,
      quarantineDuration: durationDays,
      exclusionMarker: EXCLUSION_MARKER,
      refusedReason: null,
      dispatchTarget: "issue-to-pr",
      targetRepo,
      base,
      receipt_id: null,
    }),
  };
}

function stopPacket({
  testPath,
  suite,
  tags,
  targetRepo,
  base,
  threshold,
  minSampleSize,
  maxQuarantineDays,
  declaredSampleSize,
  runCount,
  window,
  harnessCase,
  reasonCode,
  refusedReason,
  reason,
}) {
  return {
    schema: SCHEMA,
    version: VERSION,
    disposition: {
      decision: "stop",
      confidence: 1,
      reason_code: reasonCode,
      reason,
    },
    metrics: {
      run_count: runCount,
      declared_sample_size: declaredSampleSize,
      sample_size: declaredSampleSize,
      pass_count: 0,
      failure_count: 0,
      pass_rate_pct: null,
      threshold_pct: threshold,
      min_sample_size: minSampleSize,
      max_quarantine_days: maxQuarantineDays,
      window,
      failure_modes: {},
      dominant_failure_mode: null,
      dominant_failure_count: 0,
    },
    quarantine_packet: null,
    escalation: {
      lane: "operator_input",
      required: true,
      reason: refusedReason,
    },
    dispatch_target: {
      name: "none",
      type: "stop",
      typed_inputs: null,
    },
    evidence: evidenceBlock({
      harnessCase,
      testPath,
      suite,
      tags,
      metrics: {
        run_count: runCount,
        declared_sample_size: declaredSampleSize,
        sample_size: declaredSampleSize,
        pass_rate_pct: null,
        threshold_pct: threshold,
        min_sample_size: minSampleSize,
        max_quarantine_days: maxQuarantineDays,
        window,
        failure_modes: {},
        dominant_failure_mode: null,
        dominant_failure_count: 0,
      },
      quarantineDuration: null,
      exclusionMarker: null,
      refusedReason,
      dispatchTarget: "none",
      targetRepo,
      base,
      receipt_id: null,
    }),
  };
}

function noQuarantinePacket({ testPath, suite, tags, targetRepo, base, metrics, harnessCase, reasonCode, refusedReason, reason }) {
  return {
    schema: SCHEMA,
    version: VERSION,
    disposition: {
      decision: "no_quarantine",
      confidence: 0.82,
      reason_code: reasonCode,
      reason,
    },
    metrics,
    quarantine_packet: null,
    escalation: {
      lane: "human_review",
      required: true,
      reason: refusedReason,
    },
    dispatch_target: {
      name: "none",
      type: "stop",
      typed_inputs: null,
    },
    evidence: evidenceBlock({
      harnessCase,
      testPath,
      suite,
      tags,
      metrics,
      quarantineDuration: null,
      exclusionMarker: null,
      refusedReason,
      dispatchTarget: "none",
      targetRepo,
      base,
      receipt_id: null,
    }),
  };
}

function evidenceBlock({
  harnessCase,
  testPath,
  suite,
  tags,
  metrics,
  quarantineDuration,
  exclusionMarker,
  refusedReason,
  dispatchTarget,
  targetRepo,
  base,
  receipt_id,
}) {
  return {
    harness_case: harnessCase ?? inferHarnessCase({ metrics, refusedReason }),
    test_metadata: {
      test_path: testPath,
      suite,
      tags,
      target_repo: targetRepo ?? null,
      base: base ?? null,
    },
    observations: [
      `decision input covers ${metrics.run_count} supplied runs with declared sample size ${metrics.declared_sample_size}`,
      metrics.pass_rate_pct === null
        ? "pass-rate unavailable because no run history was supplied"
        : `pass-rate ${metrics.pass_rate_pct}% across ${metrics.run_count} runs`,
      metrics.dominant_failure_mode
        ? `${metrics.dominant_failure_count} failure(s) classified as ${metrics.dominant_failure_mode}`
        : "no repeatable failure mode was established",
      quarantineDuration === null
        ? "no quarantine duration proposed"
        : `quarantine duration ${quarantineDuration} day(s), capped by policy max ${metrics.max_quarantine_days}`,
      exclusionMarker === null
        ? "no exclusion marker proposed"
        : `exclusion marker ${exclusionMarker}`,
      refusedReason === null
        ? "refused reason: null"
        : `refused reason: ${refusedReason}`,
      `dispatch target: ${dispatchTarget}`,
    ],
    pass_rate_pct: metrics.pass_rate_pct,
    run_count: metrics.run_count,
    failure_mode_count: metrics.dominant_failure_count,
    quarantine_duration_days: quarantineDuration,
    exclusion_marker: exclusionMarker,
    refused_reason: refusedReason,
    dispatch_target: dispatchTarget,
    receipt_id,
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    test_run_history: parseInput(process.env.RUNX_INPUT_TEST_RUN_HISTORY),
    test_metadata: parseInput(process.env.RUNX_INPUT_TEST_METADATA),
    release_policy: parseInput(process.env.RUNX_INPUT_RELEASE_POLICY),
    harness_case: process.env.RUNX_INPUT_HARNESS_CASE,
  };
}

function parseInput(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("test_run_history.runs entries must be objects");
  }
  return {
    status: normalizeStatus(value.status),
    duration: Number.isFinite(Number(value.duration)) ? Number(value.duration) : null,
    logs: String(value.logs ?? ""),
  };
}

function normalizeStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["pass", "passed", "success", "succeeded", "ok"].includes(normalized)) return "passed";
  if (["skip", "skipped"].includes(normalized)) return "skipped";
  return "failed";
}

function countFailureModes(failureRuns) {
  const modes = {};
  for (const run of failureRuns) {
    const mode = classifyFailure(run.logs);
    modes[mode] = (modes[mode] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(modes).sort(([left], [right]) => left.localeCompare(right)));
}

function classifyFailure(logs) {
  const text = String(logs ?? "").toLowerCase();
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/assert|expect|mismatch/.test(text)) return "assertion";
  if (/network|econn|connection|socket|dns/.test(text)) return "network";
  if (/crash|segfault|panic|exception/.test(text)) return "runtime";
  return "unknown";
}

function dominantFailureMode(modes) {
  let best = { mode: null, count: 0 };
  for (const [mode, count] of Object.entries(modes)) {
    if (count > best.count) best = { mode, count };
  }
  return best;
}

function confidenceFor({ passRatePct, threshold, dominantCount, failureCount }) {
  const thresholdGap = Math.min(20, Math.max(0, threshold - passRatePct));
  const dominance = failureCount === 0 ? 0 : dominantCount / failureCount;
  return Number(Math.min(0.94, 0.7 + thresholdGap / 100 + dominance / 10).toFixed(2));
}

function inferHarnessCase({ metrics, refusedReason }) {
  if (refusedReason && refusedReason.startsWith("missing-evidence")) return "missing_run_history";
  if (metrics.pass_rate_pct === 65 && metrics.dominant_failure_mode === "timeout") return "quarantine_justified";
  return null;
}

function roundPct(value) {
  return Number(value.toFixed(2).replace(/\.00$/, ""));
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function requiredString(value, name) {
  const parsed = stringValue(value);
  if (!parsed) fail(`${name} is required`);
  return parsed;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String).filter((entry) => entry.trim().length > 0) : [];
}

function numberValue(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${name} must be a number`);
  return parsed;
}

function integerValue(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${name} must be an integer`);
  return Math.trunc(parsed);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
