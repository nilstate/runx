#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const releaseCandidate = objectInput(inputs.release_candidate, "release_candidate");
const launchPolicy = objectInput(inputs.launch_policy, "launch_policy");

const output = decide(releaseCandidate, launchPolicy);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function decide(candidate, policy) {
  const version = stringValue(candidate.version);
  const diffRef = stringValue(candidate.diff_ref);
  const requiredChecks = arrayStrings(policy.required_checks);
  const maxOpenRisk = Number.isFinite(Number(policy.max_open_risk)) ? Number(policy.max_open_risk) : 0;
  const testResults = Array.isArray(candidate.test_results) ? candidate.test_results : [];
  const risks = Array.isArray(candidate.risks) ? candidate.risks : [];
  const openRisks = risks.filter((risk) => stringValue(risk?.status)?.toLowerCase() !== "closed");
  const blockers = [];

  if (!version) blockers.push("release_candidate.version is required");
  if (!diffRef) blockers.push("release_candidate.diff_ref is required");

  const checks = requiredChecks.map((name) => {
    const result = testResults.find((item) => stringValue(item?.name)?.toLowerCase() === name.toLowerCase());
    const status = stringValue(result?.status)?.toLowerCase() ?? "missing";
    const passed = ["pass", "passed", "success", "green"].includes(status);
    if (!passed) blockers.push(`required check '${name}' is ${status}`);
    return {
      name,
      status,
      passed,
      source: stringValue(result?.source) ?? "missing from release_candidate.test_results",
    };
  });

  if (openRisks.length > maxOpenRisk) {
    blockers.push(`open risk count ${openRisks.length} exceeds policy max ${maxOpenRisk}`);
  }

  const rollback = objectOrEmpty(candidate.rollback_plan);
  const rollbackSteps = arrayStrings(rollback.steps);
  if (policy.rollback_required === true && (!rollback.tested || rollbackSteps.length === 0)) {
    blockers.push("tested rollback_plan.steps are required by policy");
  }

  const observability = objectOrEmpty(candidate.observability_plan);
  const dashboards = arrayStrings(observability.dashboards);
  const alerts = arrayStrings(observability.alerts);
  if (dashboards.length === 0) blockers.push("observability_plan.dashboards is required");
  if (alerts.length === 0) blockers.push("observability_plan.alerts is required");

  const changelog = objectOrEmpty(candidate.changelog);
  const changelogEntries = arrayStrings(changelog.entries);
  if (changelogEntries.length === 0) blockers.push("changelog.entries is required");

  const readinessReport = {
    checks,
    risks: {
      max_open_risk: maxOpenRisk,
      open_count: openRisks.length,
      open: openRisks.map((risk) => ({
        id: stringValue(risk.id) ?? stringValue(risk.name) ?? "unnamed_risk",
        status: stringValue(risk.status) ?? "open",
      })),
    },
    blockers,
  };

  const decision = blockers.length === 0 ? "go" : "no_go";
  return {
    decision,
    readiness_report: readinessReport,
    release_proposal:
      decision === "go"
        ? {
            id: `release:${digest({ version, diffRef, checks })}`,
            gated: true,
            consumer: "release",
            deploys: false,
            tags: false,
            publishes: false,
            announces: false,
            version,
            diff_ref: diffRef,
            changelog: changelogEntries,
            rollback_plan: rollbackSteps,
            observability_plan: { dashboards, alerts },
          }
        : null,
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    release_candidate: parseInputValue(process.env.RUNX_INPUT_RELEASE_CANDIDATE),
    launch_policy: parseInputValue(process.env.RUNX_INPUT_LAUNCH_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectInput(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    process.stderr.write(`${name} must be an object\n`);
    process.exit(64);
  }
  return value;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayStrings(value) {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
