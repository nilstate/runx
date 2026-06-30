import crypto from "node:crypto";

function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function normalizeSeverity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function fail(code, reason, extra = {}) {
  return {
    decision: { action: "acknowledge", reason },
    escalation: {
      status: "needs_agent",
      lane: extra.human_approval_lane ?? "oncall.human_approval",
      reason_code: code,
      reason,
    },
    packet: null,
    stop: {
      code,
      reason,
      packet_emitted: false,
      needs_agent: true,
    },
  };
}

function matchRule(rule, alert) {
  if (String(rule?.service ?? "") !== String(alert.service ?? "")) return false;
  if (rule?.severity && normalizeSeverity(rule.severity) !== normalizeSeverity(alert.severity)) return false;
  if (rule?.signal_name && String(rule.signal_name) !== String(alert.signal?.name ?? "")) return false;
  return true;
}

function renderNote(template, bindings) {
  return String(template ?? "Incident {alert_id}: {service} {severity} via {signal_name}. Runbook digest {runbook_digest}.")
    .replaceAll("{alert_id}", bindings.alert_id)
    .replaceAll("{service}", bindings.service)
    .replaceAll("{severity}", bindings.severity)
    .replaceAll("{signal_name}", bindings.signal_name)
    .replaceAll("{runbook_digest}", bindings.runbook_digest)
    .replaceAll("{policy_clause}", bindings.policy_clause);
}

function decide(alert, runbookRef, oncallPolicy) {
  for (const key of ["id", "service", "severity", "signal"]) {
    if (!alert?.[key]) return fail(`missing_alert_${key}`, `alert.${key} is required.`);
  }

  const servicePolicy = oncallPolicy?.services?.[alert.service];
  if (!servicePolicy) {
    return fail("undeclared_service", `Service ${alert.service} is not declared in oncall_policy.services.`);
  }

  if (runbookRef?.sealed !== true || !runbookRef?.digest) {
    return fail("runbook_unsealed", "Runbook is missing or unsealed; no triage packet can be emitted.", {
      human_approval_lane: servicePolicy.escalation ?? "oncall.human_approval",
    });
  }

  if (runbookRef.service && runbookRef.service !== alert.service) {
    return fail("runbook_service_mismatch", `Runbook service ${runbookRef.service} does not match alert service ${alert.service}.`);
  }

  const matchingRule = (oncallPolicy.escalation_rules ?? []).find((rule) => matchRule(rule, alert));
  const action = matchingRule?.action ?? "acknowledge";
  const allowedActions = new Set([...(servicePolicy.allowed_actions ?? []), ...(runbookRef.allowed_actions ?? [])]);
  if (!["acknowledge", "escalate", "auto_remediate", "suppress"].includes(action)) {
    return fail("unsupported_action", `Policy action ${action} is not a supported triage action.`);
  }
  if (!allowedActions.has(action) && action !== "acknowledge") {
    return fail("action_not_allowed", `Action ${action} is absent from the sealed runbook or service policy allowed_actions.`);
  }

  const pageTarget = runbookRef.page_target ?? servicePolicy.page_target;
  const incidentPrTarget = runbookRef.incident_pr_target ?? servicePolicy.incident_pr_target;
  const escalationLane = runbookRef.escalation?.lane ?? servicePolicy.escalation ?? "oncall.primary";
  const policyClause = matchingRule?.clause ?? "Declared service and sealed runbook; no escalation rule matched.";

  const decision = {
    action,
    reason: matchingRule
      ? `${matchingRule.id ?? "policy_rule"} matched ${alert.service}/${alert.severity}/${alert.signal?.name}.`
      : "No escalation rule matched; acknowledge and keep human-readable sealed evidence.",
  };

  if (["escalate", "auto_remediate"].includes(action)) {
    if (!pageTarget || !incidentPrTarget) {
      return fail("target_binding_missing", "Escalation or auto-remediation requires both page_target and incident_pr_target.", {
        human_approval_lane: escalationLane,
      });
    }

    if (action === "auto_remediate" && !runbookRef.fix_bundle) {
      return fail("missing_fix_bundle", "auto_remediate was selected but the sealed runbook carries no bounded fix bundle.", {
        human_approval_lane: escalationLane,
      });
    }

    const packet = {
      schema: "runx.oncall.triage.v1",
      alert_id: alert.id,
      service: alert.service,
      action,
      page_target: pageTarget,
      incident_pr_target: incidentPrTarget,
      pr_review_note_body: renderNote(runbookRef.pr_review_note_template, {
        alert_id: alert.id,
        service: alert.service,
        severity: alert.severity,
        signal_name: alert.signal?.name ?? "unknown_signal",
        runbook_digest: runbookRef.digest,
        policy_clause: policyClause,
      }),
      optional_fix_bundle: action === "auto_remediate" ? runbookRef.fix_bundle : null,
      dispatch_by_naming: {
        page: "separate live page send run",
        incident_pr: "issue-to-pr",
        pr_review_note: "pr-review-note",
      },
    };
    return {
      decision,
      escalation: {
        status: "eligible",
        lane: escalationLane,
        page_target: pageTarget,
        incident_pr_target: incidentPrTarget,
      },
      packet,
      stop: null,
    };
  }

  return {
    decision,
    escalation: {
      status: "not_required",
      lane: escalationLane,
    },
    packet: null,
    stop: null,
  };
}

function main() {
  const alert = jsonInput("ALERT", {});
  const runbookRef = jsonInput("RUNBOOK_REF", {});
  const oncallPolicy = jsonInput("ONCALL_POLICY", {});
  const judgment = decide(alert, runbookRef, oncallPolicy);

  const output = {
    schema: "runx.oncall.triage_judgment.v1",
    package: "oncall-alert-triage",
    version: "0.1.0",
    alert,
    runbook: {
      uri: runbookRef?.uri ?? null,
      sealed: runbookRef?.sealed === true,
      digest: runbookRef?.digest ?? null,
      computed_ref_hash: sha256(runbookRef ?? {}),
    },
    policy_clauses_applied: (oncallPolicy?.escalation_rules ?? [])
      .filter((rule) => matchRule(rule, alert))
      .map((rule) => ({ id: rule.id ?? null, clause: rule.clause ?? null, action: rule.action ?? null })),
    decision: judgment.decision,
    escalation: judgment.escalation,
    packet: judgment.packet,
    stop: judgment.stop,
    authority: {
      minted: false,
      attenuation_request: false,
      effects_emitted: false,
      pages_sent: false,
      pull_requests_opened: false,
      fixes_applied: false,
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

