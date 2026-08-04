const OBJECTIVES = new Set(["begin", "assign", "send", "resolve", "postmortem"]);
const ROLES = ["commander", "responder_lead", "comms_lead"];
const CLOSURE_OUTCOMES = new Set(["completed", "mitigated", "resolved", "verified"]);
export function admitIncident(inputs) {
  const state = object(inputs.case_state);
  const roster = array(inputs.roster);
  const approval = object(inputs.approval);
  const memberResult = object(inputs.member_result);
  const context = {
    path: "decide",
    case_id: text(inputs.case_id),
    driver_id: text(inputs.driver_id),
    objective: text(inputs.incident_objective),
    state,
    roster,
    approval,
    member_result: memberResult,
    handoff: null,
    stop_turn: null,
  };
  const findings = [];
  const finding = (code, message) => findings.push({ code, message });
  if (!context.case_id) finding("incident.case_id.missing", "case_id is required");
  if (!context.driver_id) finding("incident.driver_id.missing", "driver_id is required");
  if (!OBJECTIVES.has(context.objective)) finding("incident.objective.unsupported", "incident objective is unsupported");
  if (state.declared !== true) finding("incident.declaration.missing", "incident must be declared");
  if (!text(state.severity)) finding("incident.severity.missing", "incident severity is required");
  if (!text(state.scope)) finding("incident.scope.missing", "incident scope is required");
  const roles = roster.map((entry) => text(entry?.role));
  const principals = roster.map((entry) => text(entry?.principal));
  if (roster.length !== 3 || ROLES.some((role) => !roles.includes(role)) || new Set(roles).size !== 3) {
    finding("incident.roster.roles", "roster must contain exactly commander, responder_lead, and comms_lead");
  }
  if (principals.some((principal) => !principal) || new Set(principals).size !== principals.length) {
    finding("incident.roster.principals", "roster principals must be present and unique");
  }
  for (const entry of roster) {
    if (!text(entry?.skill) || strings(entry?.scope).length === 0) {
      finding("incident.roster.entry", `roster role ${text(entry?.role) || "unknown"} needs a skill and scope ceiling`);
    }
  }
  if (memberResult.outcome === "delivered" && !receiptRef(memberResult.receipt_ref)) {
    finding("incident.delivery.receipt", "delivered communication requires a linked Runx receipt");
  }
  if (findings.length > 0) {
    return { incident_context: stop(context, "refused", findings, findings[0].message) };
  }
  if (context.objective === "assign" && !ownerEntry(roster, state.named_owner)) {
    return {
      incident_context: stop(
        context,
        "needs_input",
        [{ code: "incident.assignment.owner", message: "assign requires a named roster owner" }],
        "name one roster role or principal in case_state.named_owner",
      ),
    };
  }
  if (context.objective === "send") {
    if (memberResult.outcome === "delivered" && receiptRef(memberResult.receipt_ref)) {
      const stopped = stop(context, "advanced", [], "linked communications receipt is ready for agency persistence");
      stopped.stop_turn.delivery_status = "receipt_supplied";
      stopped.stop_turn.delivery_receipt_ref = memberResult.receipt_ref;
      stopped.stop_turn.effect_state.provider_delivery = "receipt_supplied";
      return { incident_context: stopped };
    }
    const pending = object(state.pending_escalation);
    const handoff = object(pending.proposed_handoff);
    const comms = rosterEntry(roster, "comms_lead");
    const validHandoff = pending.status === "awaiting_approval"
      && pending.lane === "human:incident-reviewer"
      && ["send-as", "slack-notify"].includes(text(handoff.skill))
      && handoff.skill === comms?.skill
      && (text(handoff.runner) || "plan") === "plan"
      && text(handoff.principal) === comms?.principal
      && text(handoff.channel)
      && Object.keys(object(handoff.audience)).length > 0
      && digest(handoff.content_digest);
    if (!validHandoff) {
      return {
        incident_context: stop(
          context,
          "refused",
          [{ code: "incident.send.handoff", message: "send requires a roster-bound planning handoff with channel, audience, and content digest" }],
          "communication handoff is invalid",
        ),
      };
    }
    context.handoff = handoff;
    if (!text(approval.principal)) {
      const stopped = stop(context, "awaiting_approval", [], "communication planning awaits approval from comms_lead");
      stopped.stop_turn.downstream_handoff = planningHandoff(handoff, "awaiting_approval");
      return { incident_context: stopped };
    }
    if (approval.principal !== comms.principal || !text(approval.reason)) {
      return {
        incident_context: stop(
          context,
          "refused",
          [{ code: "incident.send.approval", message: "communication approval must name the exact comms_lead principal and a reason" }],
          "communication approval does not match the fixed roster",
        ),
      };
    }
  }
  if (context.objective === "resolve") {
    const memberReceipt = CLOSURE_OUTCOMES.has(memberResult.outcome) && receiptRef(memberResult.receipt_ref)
      ? memberResult.receipt_ref
      : null;
    const foldedReceipt = receiptRef(state.resolution_evidence_ref) ? state.resolution_evidence_ref : null;
    if (!memberReceipt && !foldedReceipt) {
      return {
        incident_context: stop(
          context,
          "refused",
          [{ code: "incident.resolve.evidence", message: "resolve requires linked Runx receipt evidence" }],
          "resolution evidence is missing",
        ),
      };
    }
    context.resolution_receipt_ref = memberReceipt || foldedReceipt;
  }
  return { incident_context: context };
}
export function finalizeIncident(inputs) {
  const context = object(inputs.incident_context);
  if (context.path === "stop") return { incident_turn: context.stop_turn };
  const decision = object(inputs.decision);
  const findings = [];
  const finding = (code, message) => findings.push({ code, message });
  if (!["dispatch", "escalate", "done"].includes(text(decision.decision))) {
    finding("incident.decision.unsupported", "ops-desk returned an unsupported decision");
  }
  const dispatch = object(decision.dispatch);
  let member = null;
  if (decision.decision === "dispatch") {
    member = rosterEntry(context.roster, dispatch.member);
    if (!member) finding("incident.dispatch.member", "dispatch member is outside the fixed roster");
    if (member && text(dispatch.skill) !== member.skill) finding("incident.dispatch.skill", "dispatch skill does not match the roster entry");
    if (!text(dispatch.task)) finding("incident.dispatch.task", "dispatch task is required");
    const needed = strings(dispatch.needed_scope);
    if (needed.length === 0) finding("incident.dispatch.scope", "dispatch requires a nonempty needed_scope");
    if (member && needed.some((scope) => !strings(member.scope).includes(scope))) {
      finding("incident.dispatch.scope_ceiling", "dispatch exceeds the selected roster scope ceiling");
    }
    if (dispatch.verification?.expected_receipt !== "runx.receipt.v1" || !text(dispatch.verification?.readback)) {
      finding("incident.dispatch.verification", "dispatch must require a Runx receipt and readback");
    }
    if (context.objective === "assign" && member !== ownerEntry(context.roster, context.state.named_owner)) {
      finding("incident.assignment.dispatch", "assignment dispatch does not match the named roster owner");
    }
    if (context.objective === "send" && (member?.role !== "comms_lead" || dispatch.skill !== context.handoff?.skill)) {
      finding("incident.send.dispatch", "send dispatch must select the roster comms_lead and bound handoff skill");
    }
  }
  if (findings.length > 0) {
    return { incident_turn: turn(context, "refused", null, null, null, findings, findings[0].message) };
  }
  if (decision.decision === "escalate") {
    return {
      incident_turn: turn(
        context,
        "awaiting_approval",
        null,
        Object.keys(object(decision.escalation)).length > 0 ? decision.escalation : { to: "human:incident-reviewer" },
        null,
        [],
        text(decision.reason) || "incident decision requires human review",
      ),
    };
  }
  if (decision.decision === "done") {
    if (context.objective !== "resolve" || !receiptRef(context.resolution_receipt_ref)) {
      return {
        incident_turn: turn(
          context,
          "refused",
          null,
          null,
          null,
          [{ code: "incident.resolve.invalid", message: "only resolve with linked evidence may close an incident" }],
          "ops-desk completion is not evidence-backed incident resolution",
        ),
      };
    }
    const result = turn(context, "resolved", null, null, null, [], text(decision.reason) || "resolution evidence permits agency closure");
    result.resolution_receipt_ref = context.resolution_receipt_ref;
    return { incident_turn: result };
  }
  const safeDispatch = {
    member: dispatch.member,
    skill: dispatch.skill,
    task: dispatch.task,
    needed_scope: strings(dispatch.needed_scope),
    consequence: text(dispatch.consequence),
    verification: {
      expected_receipt: dispatch.verification.expected_receipt,
      readback: dispatch.verification.readback,
    },
  };
  const handoff = context.objective === "send" ? planningHandoff(context.handoff, "ready_for_planning") : null;
  return {
    incident_turn: turn(
      context,
      "advanced",
      safeDispatch,
      null,
      handoff,
      [],
      text(decision.reason) || "incident turn advanced within the fixed roster",
    ),
  };
}
function stop(context, decision, findings, reason) {
  return { ...context, path: "stop", stop_turn: turn(context, decision, null, null, null, findings, reason) };
}
function turn(context, decision, dispatch, escalation, handoff, findings, reason) {
  const state = object(context.state);
  return {
    schema: "runx.incident.turn.v1",
    decision,
    case_id: context.case_id,
    driver_id: context.driver_id,
    turn: Number.isInteger(state.turn) && state.turn >= 0 ? state.turn + 1 : 1,
    objective: context.objective,
    severity: text(state.severity) || "unknown",
    dispatch,
    escalation,
    downstream_handoff: handoff,
    delivery_status: "not_sent",
    delivery_receipt_ref: null,
    resolution_receipt_ref: null,
    reason,
    effect_state: { agency_state: "not_persisted", provider_delivery: "not_executed" },
    validation: { status: findings.length === 0 ? "pass" : "fail", findings },
  };
}
function planningHandoff(handoff, state) {
  return {
    skill: handoff.skill,
    runner: "plan",
    state,
    inputs: {
      principal: handoff.principal,
      channel: handoff.channel,
      audience: handoff.audience,
      content_digest: handoff.content_digest,
    },
    delivery_status: "not_sent",
  };
}
function ownerEntry(roster, owner) { const value = text(owner); return array(roster).find((entry) => entry?.role === value || entry?.principal === value) || null; }
function rosterEntry(roster, role) { return array(roster).find((entry) => entry?.role === role) || null; }
function receiptRef(value) { return /^runx:receipt:sha256:[0-9a-f]{64}$/iu.test(text(value)); }
function digest(value) { return /^sha256:[0-9a-f]{64}$/iu.test(text(value)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function strings(value) { return array(value).filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean); }
