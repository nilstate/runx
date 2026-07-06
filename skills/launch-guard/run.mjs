import fs from "node:fs";

const SCHEMA = "runx.launch_guard.v1";
const VERSION = "0.1.0";

const inputs = readInputs();
const releaseCandidate = objectValue(inputs.release_candidate, "release_candidate");
const launchPolicy = objectValue(inputs.launch_policy, "launch_policy");
const packet = guard({
  releaseCandidate,
  launchPolicy,
  harnessCase: stringValue(inputs.harness_case),
});

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
if (packet.decision.status === "no_go") {
  process.exit(64);
}

function guard({ releaseCandidate, launchPolicy, harnessCase }) {
  const version = requiredString(releaseCandidate.version, "release_candidate.version");
  const diffRef = requiredString(releaseCandidate.diff_ref, "release_candidate.diff_ref");
  const testResults = normalizeTestResults(releaseCandidate.test_results);
  const rollbackPlan = objectValue(releaseCandidate.rollback_plan, "release_candidate.rollback_plan");
  const observabilityPlan = objectValue(releaseCandidate.observability_plan, "release_candidate.observability_plan");
  const changelog = objectValue(releaseCandidate.changelog, "release_candidate.changelog");
  const risks = normalizeRisks(releaseCandidate.risks);
  const requiredChecks = arrayOfStrings(launchPolicy.required_checks);
  const maxOpenRisk = integerValue(launchPolicy.max_open_risk, "launch_policy.max_open_risk");
  const rollbackRequired = Boolean(launchPolicy.rollback_required);

  if (requiredChecks.length === 0) {
    fail("launch_policy.required_checks must include at least one check");
  }

  const checks = [];
  const blockers = [];

  for (const checkName of requiredChecks) {
    const check = evaluateRequiredCheck({
      checkName,
      testResults,
      rollbackPlan,
      observabilityPlan,
      changelog,
      rollbackRequired,
    });
    checks.push(check);
    if (!check.passed) blockers.push(check.blocker);
  }

  const openRisks = risks.filter((risk) => risk.status === "open");
  const riskCheck = {
    name: "open_risk_count",
    required_by_policy: "launch_policy.max_open_risk",
    passed: openRisks.length <= maxOpenRisk,
    observed: openRisks.length,
    threshold: maxOpenRisk,
    evidence: `${openRisks.length} open risk(s) supplied; policy maximum is ${maxOpenRisk}.`,
  };
  checks.push(riskCheck);
  if (!riskCheck.passed) {
    blockers.push(`open_risk_count: ${openRisks.length} open risk(s) exceeds policy max ${maxOpenRisk}`);
  }

  const noGo = blockers.length > 0;
  const readinessReport = {
    checks,
    risks,
    blockers,
  };

  if (noGo) {
    return {
      schema: SCHEMA,
      version: VERSION,
      decision: {
        status: "no_go",
        confidence: 0.93,
        reason_code: "launch-blockers-present",
        reason: `No-go: ${blockers.length} exact blocker(s): ${blockers.join("; ")}.`,
      },
      readiness_report: readinessReport,
      release_proposal: null,
      escalation: {
        lane: "release_owner",
        required: true,
        reason: "A release owner must clear the named blockers before a separate release run is allowed.",
      },
      evidence: evidenceBlock({
        harnessCase,
        decision: "no_go",
        checks,
        blockers,
        proposalStatus: "absent",
        version,
        diffRef,
        openRiskCount: openRisks.length,
        maxOpenRisk,
        receiptId: null,
      }),
    };
  }

  return {
    schema: SCHEMA,
    version: VERSION,
    decision: {
      status: "go",
      confidence: confidenceFor({ checks, openRiskCount: openRisks.length, maxOpenRisk }),
      reason_code: "launch-ready",
      reason: `All ${requiredChecks.length} required launch check(s) passed and ${openRisks.length} open risk(s) are within policy max ${maxOpenRisk}.`,
    },
    readiness_report: readinessReport,
    release_proposal: {
      version,
      diff_ref: diffRef,
      consumed_by: "release",
      gated: true,
      proposal_kind: "release_proposal",
      changelog_summary: summarizeChangelog(changelog),
      operator_note: "This proposal is inert evidence for a separate release runner or human release owner; launch-guard performs no deploy, tag, publish, or announcement.",
    },
    escalation: {
      lane: "human_release_gate",
      required: true,
      reason: "A separate release runner or human release owner must approve and execute any live release.",
    },
    evidence: evidenceBlock({
      harnessCase,
      decision: "go",
      checks,
      blockers,
      proposalStatus: "present",
      version,
      diffRef,
      openRiskCount: openRisks.length,
      maxOpenRisk,
      receiptId: null,
    }),
  };
}

function evaluateRequiredCheck({ checkName, testResults, rollbackPlan, observabilityPlan, changelog, rollbackRequired }) {
  if (checkName === "rollback_plan") {
    const present = Boolean(rollbackPlan.present);
    const tested = Boolean(rollbackPlan.tested);
    const passed = rollbackRequired ? present && tested : present;
    return {
      name: checkName,
      required_by_policy: "launch_policy.required_checks",
      passed,
      evidence: stringValue(rollbackPlan.evidence) ?? `rollback_plan.present=${present}, rollback_plan.tested=${tested}`,
      source: "release_candidate.rollback_plan",
      blocker: passed
        ? null
        : rollbackRequired
          ? "rollback_plan: rollback evidence is required but the plan is missing or untested"
          : "rollback_plan: rollback plan is missing",
    };
  }

  if (checkName === "observability_plan") {
    const dashboards = arrayOfStrings(observabilityPlan.dashboards);
    const alerts = arrayOfStrings(observabilityPlan.alerts);
    const passed = dashboards.length > 0 && alerts.length > 0;
    return {
      name: checkName,
      required_by_policy: "launch_policy.required_checks",
      passed,
      evidence: stringValue(observabilityPlan.evidence) ?? `${dashboards.length} dashboard(s), ${alerts.length} alert(s) supplied`,
      source: "release_candidate.observability_plan",
      dashboards,
      alerts,
      blocker: passed ? null : "observability_plan: at least one dashboard and one alert are required",
    };
  }

  if (checkName === "changelog") {
    const entries = arrayOfStrings(changelog.entries);
    const passed = entries.length > 0;
    return {
      name: checkName,
      required_by_policy: "launch_policy.required_checks",
      passed,
      evidence: passed ? `${entries.length} changelog entr${entries.length === 1 ? "y" : "ies"} supplied` : "no changelog entries supplied",
      source: "release_candidate.changelog",
      blocker: passed ? null : "changelog: at least one changelog entry is required",
    };
  }

  const result = testResults.find((entry) => entry.name === checkName);
  if (!result) {
    return {
      name: checkName,
      required_by_policy: "launch_policy.required_checks",
      passed: false,
      evidence: `missing test result for required check ${checkName}`,
      source: "release_candidate.test_results",
      blocker: `${checkName}: required check is missing from release_candidate.test_results`,
    };
  }

  const passed = result.status === "passed";
  return {
    name: checkName,
    required_by_policy: "launch_policy.required_checks",
    passed,
    status: result.status,
    evidence: result.evidence,
    source: "release_candidate.test_results",
    blocker: passed ? null : `${checkName}: required check status is ${result.status}`,
  };
}

function evidenceBlock({ harnessCase, decision, checks, blockers, proposalStatus, version, diffRef, openRiskCount, maxOpenRisk, receiptId }) {
  return {
    harness_case: harnessCase ?? inferHarnessCase(decision),
    decision,
    version,
    diff_ref: diffRef,
    checks: checks.map((check) => ({
      name: check.name,
      passed: check.passed,
      evidence: check.evidence,
      source: check.source ?? check.required_by_policy,
    })),
    blockers,
    blocker_count: blockers.length,
    proposal_status: proposalStatus,
    open_risk_count: openRiskCount,
    max_open_risk: maxOpenRisk,
    observations: [
      `decision: ${decision}`,
      `checks evaluated: ${checks.map((check) => `${check.name}=${check.passed ? "passed" : "blocked"}`).join(", ")}`,
      blockers.length === 0 ? "blockers: none" : `blockers: ${blockers.join("; ")}`,
      `release_proposal: ${proposalStatus}`,
      `open risks: ${openRiskCount}, policy max: ${maxOpenRisk}`,
      `receipt id: ${receiptId ?? "pending receipt seal"}`,
    ],
    receipt_id: receiptId,
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
    release_candidate: parseInput(process.env.RUNX_INPUT_RELEASE_CANDIDATE),
    launch_policy: parseInput(process.env.RUNX_INPUT_LAUNCH_POLICY),
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

function normalizeTestResults(value) {
  if (!Array.isArray(value)) fail("release_candidate.test_results must be an array");
  return value.map((entry, index) => {
    const item = objectValue(entry, `release_candidate.test_results[${index}]`);
    return {
      name: requiredString(item.name, `release_candidate.test_results[${index}].name`),
      status: normalizeStatus(item.status),
      evidence: requiredString(item.evidence, `release_candidate.test_results[${index}].evidence`),
    };
  });
}

function normalizeStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["pass", "passed", "success", "succeeded", "ok", "green"].includes(normalized)) return "passed";
  if (["skip", "skipped"].includes(normalized)) return "skipped";
  return "failed";
}

function normalizeRisks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = objectValue(entry, `release_candidate.risks[${index}]`);
    return {
      id: stringValue(item.id) ?? `risk-${index + 1}`,
      status: normalizeRiskStatus(item.status),
      severity: stringValue(item.severity) ?? "unknown",
      summary: requiredString(item.summary, `release_candidate.risks[${index}].summary`),
    };
  });
}

function normalizeRiskStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["closed", "resolved", "accepted"].includes(normalized) ? "closed" : "open";
}

function summarizeChangelog(changelog) {
  const entries = arrayOfStrings(changelog.entries);
  return entries.slice(0, 3).join(" ");
}

function confidenceFor({ checks, openRiskCount, maxOpenRisk }) {
  const passed = checks.filter((check) => check.passed).length;
  const base = 0.78 + passed / Math.max(1, checks.length) / 10;
  const riskBonus = maxOpenRisk === 0 ? 0 : Math.max(0, maxOpenRisk - openRiskCount) / Math.max(1, maxOpenRisk) / 20;
  return Number(Math.min(0.95, base + riskBonus).toFixed(2));
}

function inferHarnessCase(decision) {
  return decision === "go" ? "release_go" : "blocked_no_go";
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
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
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
