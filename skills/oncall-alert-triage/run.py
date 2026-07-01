#!/usr/bin/env python3
import json
import os
import sys


def main():
    inputs = read_inputs()
    alert = object_value(inputs.get("alert"), "alert")
    runbook_ref = object_value(inputs.get("runbook_ref"), "runbook_ref")
    oncall_policy = object_value(inputs.get("oncall_policy"), "oncall_policy")
    result = triage(alert, runbook_ref, oncall_policy)
    print(json.dumps(result, indent=2))


def triage(alert, runbook_ref, oncall_policy):
    alert_id = required_string(alert.get("id"), "alert.id")
    service = required_string(alert.get("service"), "alert.service")
    severity = required_string(alert.get("severity"), "alert.severity").lower()
    signal = required_string(alert.get("signal"), "alert.signal")
    services = oncall_policy.get("services") if isinstance(oncall_policy.get("services"), list) else []
    escalation_rules = object_value(oncall_policy.get("escalation_rules", {}), "oncall_policy.escalation_rules")
    rule = object_value(escalation_rules.get(service, {}), f"oncall_policy.escalation_rules.{service}")
    allowed_actions = rule.get("allowed_actions") if isinstance(rule.get("allowed_actions"), list) else []

    refusal_reason = refusal_for(service, services, runbook_ref, rule, allowed_actions)
    if refusal_reason:
        return {
            "decision": {
                "action": "suppress",
                "reason": refusal_reason,
            },
            "triage_packet": None,
            "refusal": {
                "reason": refusal_reason,
            },
        }

    action = "escalate" if severity == "page" and "escalate" in allowed_actions else "acknowledge"
    escalation = runbook_ref.get("escalation") if isinstance(runbook_ref.get("escalation"), dict) else {}
    page_target = string_value(escalation.get("page_target")) or required_string(rule.get("page_target"), f"oncall_policy.escalation_rules.{service}.page_target")
    incident_pr_target = string_value(escalation.get("incident_pr_target")) or required_string(rule.get("incident_pr_target"), f"oncall_policy.escalation_rules.{service}.incident_pr_target")
    pr_review_note_body = string_value(escalation.get("pr_review_note_body")) or f"Escalate {service} alert {alert_id}: {signal}"
    runbook_digest = required_string(runbook_ref.get("digest"), "runbook_ref.digest")

    return {
        "decision": {
            "action": action,
            "reason": "The alert is page-severity, the service is declared in policy, and the sealed runbook binds page and incident PR targets." if action == "escalate" else "The alert is in policy and has sealed runbook evidence, but it does not require escalation.",
        },
        "triage_packet": {
            "schema": "runx.oncall.triage.v1",
            "page_target": page_target,
            "incident_pr_target": incident_pr_target,
            "pr_review_note_body": pr_review_note_body,
            "fix_bundle": None,
            "escalation": "human_oncall_required",
            "evidence": {
                "alert_id": alert_id,
                "service": service,
                "severity": severity,
                "signal": signal,
                "runbook_digest": runbook_digest,
                "policy_clause": f"{service}.escalation_rules",
                "side_effects": "none",
            },
        } if action == "escalate" else None,
        "refusal": {
            "reason": None,
        },
    }


def refusal_for(service, services, runbook_ref, rule, allowed_actions):
    if service not in services:
        return f"Service {service} is not declared in oncall_policy.services."
    if runbook_ref.get("sealed") is not True:
        return "runbook_ref.sealed must be true before emitting an on-call packet."
    if not string_value(runbook_ref.get("digest")):
        return "runbook_ref.digest is required for receipt-backed triage."
    escalation = runbook_ref.get("escalation") if isinstance(runbook_ref.get("escalation"), dict) else {}
    page_target = string_value(escalation.get("page_target")) or string_value(rule.get("page_target"))
    incident_pr_target = string_value(escalation.get("incident_pr_target")) or string_value(rule.get("incident_pr_target"))
    if not page_target:
        return "No page_target is bound by the sealed runbook or service policy."
    if not incident_pr_target:
        return "No incident_pr_target is bound by the sealed runbook or service policy."
    if "escalate" not in allowed_actions and "acknowledge" not in allowed_actions:
        return "No allowed on-call action is declared for the service."
    return None


def read_inputs():
    inputs_path = os.environ.get("RUNX_INPUTS_PATH")
    if inputs_path:
        with open(inputs_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    inputs_json = os.environ.get("RUNX_INPUTS_JSON")
    if inputs_json:
        return json.loads(inputs_json)
    return {
        "alert": parse_input_value(os.environ.get("RUNX_INPUT_ALERT")),
        "runbook_ref": parse_input_value(os.environ.get("RUNX_INPUT_RUNBOOK_REF")),
        "oncall_policy": parse_input_value(os.environ.get("RUNX_INPUT_ONCALL_POLICY")),
        "operator_context": os.environ.get("RUNX_INPUT_OPERATOR_CONTEXT"),
    }


def parse_input_value(raw):
    if raw is None or raw == "":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def object_value(value, name):
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def required_string(value, name):
    text = string_value(value)
    if not text:
        fail(f"{name} is required")
    return text


def string_value(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(64)


if __name__ == "__main__":
    main()
