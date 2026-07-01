#!/usr/bin/env node

import fs from "node:fs";

function main() {
  const inputs = readInputs();
  const alert = objectValue(inputs.alert, "alert");
  const runbookRef = objectValue(inputs.runbook_ref, "runbook_ref");
  const oncallPolicy = objectValue(inputs.oncall_policy, "oncall_policy");
  const result = triage(alert, runbookRef, oncallPolicy);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.refusal.reason) process.exitCode = 64;
}

function triage(alert, runbookRef, oncallPolicy) {
  const alertId = requiredString(alert.id, "alert.id");
  const service = requiredString(alert.service, "alert.service");
  const severity = requiredString(alert.severity, "alert.severity").toLowerCase();
  const signal = requiredString(alert.signal, "alert.signal");
  const services = Array.isArray(oncallPolicy.services) ? oncallPolicy.services : [];
  const escalationRules = objectValue(oncallPolicy.escalation_rules ?? {}, "oncall_policy.escalation_rules");
  const rule = objectValue(escalationRules[service] ?? {}, `oncall_policy.escalation_rules.${service}`);
  const allowedActions = Array.isArray(rule.allowed_actions) ? rule.allowed_actions : [];

  const refusalReason = refusalFor(service, services, runbookRef, rule, allowedActions);
  if (refusalReason) {
    return {
      decision: { action: "suppress", reason: refusalReason },
      triage_packet: null,
      refusal: { reason: refusalReason },
    };
  }

  const action = severity === "page" && allowedActions.includes("escalate")
    ? "escalate"
    : "acknowledge";
  const escalation = isObject(runbookRef.escalation) ? runbookRef.escalation : {};
  const pageTarget = stringValue(escalation.page_target)
    ?? requiredString(rule.page_target, `oncall_policy.escalation_rules.${service}.page_target`);
  const incidentPrTarget = stringValue(escalation.incident_pr_target)
    ?? requiredString(rule.incident_pr_target, `oncall_policy.escalation_rules.${service}.incident_pr_target`);
  const prReviewNoteBody = stringValue(escalation.pr_review_note_body)
    ?? `Escalate ${service} alert ${alertId}: ${signal}`;
  const runbookDigest = requiredString(runbookRef.digest, "runbook_ref.digest");

  return {
    decision: {
      action,
      reason: action === "escalate"
        ? "The alert is page-severity, the service is declared in policy, and the sealed runbook binds page and incident PR targets."
        : "The alert is in policy and has sealed runbook evidence, but it does not require escalation.",
    },
    triage_packet: action === "escalate" ? {
      schema: "runx.oncall.triage.v1",
      page_target: pageTarget,
      incident_pr_target: incidentPrTarget,
      pr_review_note_body: prReviewNoteBody,
      fix_bundle: null,
      escalation: "human_oncall_required",
      evidence: {
        alert_id: alertId,
        service,
        severity,
        signal,
        runbook_digest: runbookDigest,
        policy_clause: `${service}.escalation_rules`,
        side_effects: "none",
      },
    } : null,
    refusal: { reason: null },
  };
}

function refusalFor(service, services, runbookRef, rule, allowedActions) {
  if (!services.includes(service)) {
    return `Service ${service} is not declared in oncall_policy.services.`;
  }
  if (runbookRef.sealed !== true) {
    return "runbook_ref.sealed must be true before emitting an on-call packet.";
  }
  if (!stringValue(runbookRef.digest)) {
    return "runbook_ref.digest is required for receipt-backed triage.";
  }
  const escalation = isObject(runbookRef.escalation) ? runbookRef.escalation : {};
  if (!(stringValue(escalation.page_target) ?? stringValue(rule.page_target))) {
    return "No page_target is bound by the sealed runbook or service policy.";
  }
  if (!(stringValue(escalation.incident_pr_target) ?? stringValue(rule.incident_pr_target))) {
    return "No incident_pr_target is bound by the sealed runbook or service policy.";
  }
  if (!allowedActions.includes("escalate") && !allowedActions.includes("acknowledge")) {
    return "No allowed on-call action is declared for the service.";
  }
  return null;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    alert: parseInputValue(process.env.RUNX_INPUT_ALERT),
    runbook_ref: parseInputValue(process.env.RUNX_INPUT_RUNBOOK_REF),
    oncall_policy: parseInputValue(process.env.RUNX_INPUT_ONCALL_POLICY),
    operator_context: process.env.RUNX_INPUT_OPERATOR_CONTEXT,
  };
}

function parseInputValue(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function requiredString(value, name) {
  const text = stringValue(value);
  if (!text) fail(`${name} is required`);
  return text;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

main();
