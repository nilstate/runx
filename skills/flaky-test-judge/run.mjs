function readJson(name, fallback) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const testRunHistory = readJson("TEST_RUN_HISTORY", { runs: [], sample_size: 0 });
const testMetadata = readJson("TEST_METADATA", {});
const releasePolicy = readJson("RELEASE_POLICY", {});

const runs = Array.isArray(testRunHistory.runs) ? testRunHistory.runs : [];
const citedRunCount = Number(testRunHistory.sample_size || runs.length || 0);
const threshold = Number(releasePolicy.flake_threshold_pct ?? 70);
const minSampleSize = Number(releasePolicy.min_sample_size ?? 20);
const maxQuarantineDays = Number(releasePolicy.max_quarantine_days ?? 14);

const passStatuses = new Set(["pass", "passed", "success", "ok"]);
const passCount = runs.filter((run) => passStatuses.has(String(run.status || "").toLowerCase())).length;
const failureCount = Math.max(0, runs.length - passCount);
const passRatePct = runs.length > 0 ? Number(((passCount / runs.length) * 100).toFixed(1)) : null;

const failureModes = {
  timeout: 0,
  assertion: 0,
  network: 0,
  crash: 0,
  other: 0
};

for (const run of runs) {
  if (passStatuses.has(String(run.status || "").toLowerCase())) continue;
  const logs = String(run.logs || "");
  if (/timeout|timed out|deadline/i.test(logs)) failureModes.timeout += 1;
  else if (/assert|expect|mismatch/i.test(logs)) failureModes.assertion += 1;
  else if (/network|econn|socket|dns/i.test(logs)) failureModes.network += 1;
  else if (/segfault|crash|panic|fatal/i.test(logs)) failureModes.crash += 1;
  else failureModes.other += 1;
}

let disposition;
let quarantine_packet = null;
let escalation = {
  lane: "none",
  reason: "sufficient evidence for local disposition"
};
let dispatch_target = null;

if (runs.length === 0 || citedRunCount === 0) {
  disposition = {
    decision: "stop",
    confidence: 1,
    reason: "missing-evidence: no run history was supplied, so quarantine is refused"
  };
  escalation = {
    lane: "human_review",
    reason: "missing run history; collect recent test-run receipts before quarantine"
  };
} else if (citedRunCount < minSampleSize || runs.length < minSampleSize) {
  disposition = {
    decision: "stop",
    confidence: 0.96,
    reason: `sample-below-minimum: ${runs.length} observed runs / ${citedRunCount} cited runs is below policy minimum ${minSampleSize}`
  };
  escalation = {
    lane: "human_review",
    reason: "insufficient sample size; collect more runs"
  };
} else if (passRatePct >= threshold) {
  disposition = {
    decision: "no_quarantine",
    confidence: 0.9,
    reason: `pass-rate-above-threshold: ${passRatePct}% over ${runs.length} runs is at or above policy threshold ${threshold}%`
  };
} else {
  const timeoutDominates = failureCount > 0 && failureModes.timeout / failureCount >= 0.6;
  const nearThreshold = threshold - passRatePct <= 5;
  const durationDays = Math.max(1, Math.min(maxQuarantineDays, timeoutDominates ? 7 : 3));
  disposition = {
    decision: "quarantine",
    confidence: nearThreshold ? 0.72 : 0.86,
    reason: `${passRatePct}% pass rate over ${runs.length} runs is below ${threshold}% policy threshold; ${failureModes.timeout} of ${failureCount} failures cite timeout evidence`
  };
  quarantine_packet = {
    test_path: testMetadata.test_path || "unknown-test-path",
    duration_days: durationDays,
    fix_template: {
      title: `Fix flaky test ${testMetadata.test_path || "unknown-test-path"}`,
      body: [
        `Observed ${passCount}/${runs.length} passes (${passRatePct}%) against a ${threshold}% release threshold.`,
        `Failure modes from supplied logs: timeout=${failureModes.timeout}, assertion=${failureModes.assertion}, network=${failureModes.network}, crash=${failureModes.crash}, other=${failureModes.other}.`,
        "Investigate root cause, remove the quarantine marker, and add a regression note before re-enabling."
      ].join("\n")
    },
    exclusion_marker: `@runx-flaky-quarantine(${durationDays}d,max=${maxQuarantineDays}d,path=${testMetadata.test_path || "unknown"})`
  };
  dispatch_target = {
    mode: "dispatch-by-naming",
    skill: "issue-to-pr",
    note: "The judge emits data only; an operator or downstream driver separately invokes issue-to-pr and a human merge gate controls any live disable.",
    typed_inputs: {
      thread_title: quarantine_packet.fix_template.title,
      thread_body: `${quarantine_packet.fix_template.body}\n\nRequested temporary exclusion marker: ${quarantine_packet.exclusion_marker}`,
      target_repo: "<operator-target-repo>",
      base: "<operator-selected-base-branch>"
    },
    offline_leg: {
      skill: "pr-review-note",
      body: quarantine_packet.fix_template.body
    }
  };
  if (nearThreshold) {
    escalation = {
      lane: "human_review",
      reason: "near-threshold evidence; human release owner should review before downstream issue-to-pr"
    };
  }
}

const packet = {
  schema: "runx.flaky.test_triage.v1",
  disposition,
  quarantine_packet,
  escalation,
  dispatch_target,
  evidence: {
    test_path: testMetadata.test_path || null,
    suite: testMetadata.suite || null,
    tags: Array.isArray(testMetadata.tags) ? testMetadata.tags : [],
    sample_size: citedRunCount,
    observed_runs: runs.length,
    pass_count: passCount,
    failure_count: failureCount,
    pass_rate_pct: passRatePct,
    policy_threshold_pct: threshold,
    min_sample_size: minSampleSize,
    max_quarantine_days: maxQuarantineDays,
    failure_modes: failureModes
  },
  invariants: {
    mutates_repo: false,
    fires_pr_run: false,
    mints: false,
    consumes_downstream_effect: false
  }
};

process.stdout.write(`${JSON.stringify(packet)}\n`);
