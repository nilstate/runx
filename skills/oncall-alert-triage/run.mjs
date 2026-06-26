import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "oncall.triage.decision.v1";
const PACKET_SCHEMA = "runx.oncall.triage.v1";

const inputs = readInputs();
const skillRoot = process.cwd();

const alert = inputs.alert;
const runbookRef = inputs.runbook_ref;
const policy = inputs.oncall_policy;

if (!alert || typeof alert !== "object") {
  throw new Error("alert input is required");
}
if (!policy || typeof policy !== "object") {
  throw new Error("oncall_policy input is required");
}

// Validate alert fields
const requiredFields = ["id", "service", "severity", "signal"];
const missingFields = requiredFields.filter((f) => !alert[f]);
if (missingFields.length > 0) {
  throw new Error(`alert missing required fields: ${missingFields.join(", ")}`);
}

const serviceInPolicy = Array.isArray(policy.services) && policy.services.includes(alert.service);
const runbookSealed = typeof runbookRef === "string" && runbookRef.length > 0;

// Look up escalation rule
let escalationRule = null;
let ruleFound = false;
if (serviceInPolicy && policy.escalation_rules && typeof policy.escalation_rules === "object") {
  const serviceRules = policy.escalation_rules[alert.service];
  if (serviceRules && typeof serviceRules === "object") {
    const severityKey = `severity_${alert.severity}`;
    if (severityKey in serviceRules) {
      escalationRule = serviceRules[severityKey];
      ruleFound = true;
    }
  }
}

// Determine decision
let decision;
let packet = null;
let runxStatus = "sealed";

if (!runbookSealed) {
  decision = {
    action: "escalate",
    reason: `Runbook is missing or unsealed for alert ${alert.id} on service ${alert.service}. Needs agent to resolve.`,
  };
  runxStatus = "needs_agent";
} else if (!serviceInPolicy) {
  decision = {
    action: "escalate",
    reason: `Service ${alert.service} is not declared in oncall_policy.services. Needs agent to resolve.`,
  };
  runxStatus = "needs_agent";
} else if (!ruleFound) {
  decision = {
    action: "escalate",
    reason: `No escalation rule found for service ${alert.service} with severity ${alert.severity}. Needs agent to resolve.`,
  };
  runxStatus = "needs_agent";
} else {
  // Rule found — apply it
  switch (escalationRule) {
    case "escalate":
      decision = {
        action: "escalate",
        reason: `Alert ${alert.id} on ${alert.service} (${alert.severity}) matches escalation rule.`,
      };
      packet = {
        schema: PACKET_SCHEMA,
        page_target: `oncall:${alert.service}:${alert.severity}`,
        incident_pr_target: `pr:${alert.service}:incident-${alert.id}`,
        pr_review_note_body: `Oncall alert ${alert.id}: ${alert.signal} on ${alert.service} (${alert.severity}). See runbook ${runbookRef}.`,
        escalation: {
          alert_id: alert.id,
          service: alert.service,
          severity: alert.severity,
          signal: alert.signal,
          runbook_ref: runbookRef,
        },
      };
      break;
    case "acknowledge":
      decision = {
        action: "acknowledge",
        reason: `Alert ${alert.id} on ${alert.service} (${alert.severity}) matches acknowledge rule. No page emitted.`,
      };
      break;
    case "auto_remediate":
      decision = {
        action: "auto_remediate",
        reason: `Alert ${alert.id} on ${alert.service} (${alert.severity}) matches auto-remediate rule.`,
      };
      packet = {
        schema: PACKET_SCHEMA,
        page_target: `oncall:${alert.service}:${alert.severity}`,
        incident_pr_target: `pr:${alert.service}:incident-${alert.id}`,
        pr_review_note_body: `Auto-remediation for alert ${alert.id}: ${alert.signal} on ${alert.service}. See runbook ${runbookRef}.`,
        escalation: {
          alert_id: alert.id,
          service: alert.service,
          severity: alert.severity,
          signal: alert.signal,
          runbook_ref: runbookRef,
        },
      };
      break;
    case "suppress":
      decision = {
        action: "suppress",
        reason: `Alert ${alert.id} on ${alert.service} (${alert.severity}) matches suppress rule. Suppressed.`,
      };
      break;
    default:
      decision = {
        action: "escalate",
        reason: `Unknown escalation rule '${escalationRule}' for ${alert.service}:${alert.severity}. Escalating to human.`,
      };
      runxStatus = "needs_agent";
  }
}

// Build result
const result = {
  schema: SCHEMA,
  status: runxStatus,
  data: {
    decision,
    alert: {
      id: alert.id,
      service: alert.service,
      severity: alert.severity,
      signal: alert.signal,
    },
    runbook_ref: runbookRef,
    packet,
    validation: {
      valid: serviceInPolicy && runbookSealed && ruleFound,
      service_in_policy: serviceInPolicy,
      runbook_sealed: runbookSealed,
      escalation_rule_found: ruleFound,
    },
  },
};

// Write artifacts
const report = renderReport(result);
writeArtifacts(inputs.output_dir, result, report, skillRoot);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// Exit with non-zero for needs_agent so harness sees "failure" status
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
  lines.push("# Oncall Alert Triage Report");
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  lines.push(`- **Action:** ${d.decision.action}`);
  lines.push(`- **Reason:** ${d.decision.reason}`);
  lines.push("");
  lines.push("## Alert");
  lines.push("");
  lines.push(`- **ID:** ${d.alert.id}`);
  lines.push(`- **Service:** ${d.alert.service}`);
  lines.push(`- **Severity:** ${d.alert.severity}`);
  lines.push(`- **Signal:** ${d.alert.signal}`);
  lines.push("");
  lines.push(`- **Runbook:** ${d.runbook_ref || "(missing)"}`);
  lines.push("");

  if (d.packet) {
    lines.push("## Packet");
    lines.push("");
    lines.push(`- **Page target:** ${d.packet.page_target}`);
    lines.push(`- **Incident PR target:** ${d.packet.incident_pr_target}`);
    lines.push(`- **PR review note:** ${d.packet.pr_review_note_body}`);
    lines.push("");
  }

  lines.push("## Validation");
  lines.push("");
  lines.push(`- Service in policy: ${d.validation.service_in_policy ? "yes" : "no"}`);
  lines.push(`- Runbook sealed: ${d.validation.runbook_sealed ? "yes" : "no"}`);
  lines.push(`- Escalation rule found: ${d.validation.escalation_rule_found ? "yes" : "no"}`);
  lines.push(`- Valid: ${d.validation.valid ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Reproducibility Controls");
  lines.push("");
  lines.push("- Every triage decision is grounded in sealed alert data, runbook, and policy.");
  lines.push("- Missing or unsealed runbooks escalate to needs_agent; no packet is emitted.");
  lines.push("- Undeclared services escalate to needs_agent; no packet is emitted.");
  lines.push("- The skill never invents remediation steps or escalation paths.");
  lines.push("- The packet is read-only and not consumed as an effect.");
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
