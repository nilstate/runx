import fs from "node:fs";

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function refused(base, reason) {
  return {
    incident_turn: {
      ...base,
      status: "refused",
      dispatch: null,
      escalation: { lane: "human:incident-reviewer", reason },
      named_run: null,
      reason,
    },
  };
}

function rosterEntry(roster, role) {
  return asArray(roster).find((entry) => entry?.role === role) ?? null;
}

function validateRoster(roster) {
  const requiredRoles = ["commander", "responder_lead", "comms_lead"];
  if (!Array.isArray(roster) || roster.length !== requiredRoles.length) {
    return "incident roster must contain exactly commander, responder_lead, and comms_lead";
  }
  const roles = roster.map((entry) => entry?.role);
  if (new Set(roles).size !== roles.length || requiredRoles.some((role) => !roles.includes(role))) {
    return "incident roster roles are missing or duplicated";
  }
  const incomplete = roster.find(
    (entry) => !entry?.principal || !entry?.skill || !Array.isArray(entry?.scope) || entry.scope.length === 0,
  );
  return incomplete ? `roster role ${incomplete.role ?? "unknown"} lacks principal, skill, or scope` : null;
}

function validateDispatch(decision, roster) {
  if (decision?.decision !== "dispatch") return "ops-desk did not return a dispatch";
  const dispatch = decision.dispatch ?? {};
  const member = rosterEntry(roster, dispatch.member);
  if (!member) return `dispatch member ${dispatch.member ?? "missing"} is not in the incident roster`;
  if (dispatch.skill !== member.skill) {
    return `dispatch skill ${dispatch.skill ?? "missing"} does not match roster skill ${member.skill}`;
  }
  if (typeof dispatch.task !== "string" || !dispatch.task.trim()) {
    return "dispatch task must be a nonempty string";
  }
  const consequences = new Set([
    "read_only",
    "draft",
    "live_mutation",
    "public_send",
    "deploy",
    "stakeholder_send_handoff",
    "incident_response",
    "postmortem",
  ]);
  if (!consequences.has(dispatch.consequence)) {
    return `dispatch consequence ${dispatch.consequence ?? "missing"} is not supported`;
  }
  if (
    dispatch.verification?.expected_receipt !== "runx.receipt.v1" ||
    typeof dispatch.verification?.readback !== "string" ||
    !dispatch.verification.readback.trim()
  ) {
    return "dispatch verification must require runx.receipt.v1 and a nonempty readback";
  }
  if (
    !Array.isArray(dispatch.needed_scope) ||
    dispatch.needed_scope.length === 0 ||
    dispatch.needed_scope.some((scope) => typeof scope !== "string" || !scope.trim())
  ) {
    return "dispatch needed_scope must be a nonempty array of canonical scope strings";
  }
  const extra = dispatch.needed_scope.filter((scope) => !member.scope.includes(scope));
  return extra.length ? `dispatch exceeds ${member.role} scope ceiling: ${extra.join(", ")}` : null;
}

function safeDispatch(decision) {
  const dispatch = decision.dispatch;
  return {
    member: dispatch.member,
    skill: dispatch.skill,
    task: dispatch.task,
    needed_scope: [...dispatch.needed_scope],
    consequence: dispatch.consequence,
    verification: {
      expected_receipt: dispatch.verification.expected_receipt,
      readback: dispatch.verification.readback,
    },
  };
}

function validReceiptRef(value) {
  return /^runx:receipt:sha256:[0-9a-f]{64}$/i.test(value ?? "");
}

const inputs = readInputs();
const objective = inputs.incident_objective;
const allowedObjectives = new Set(["begin", "assign", "send", "resolve", "postmortem"]);
const caseState = inputs.case_state ?? {};
const roster = inputs.roster;
const approval = inputs.approval ?? null;
const memberResult = inputs.member_result ?? null;
const decision = inputs.decision ?? {};
const priorTurn = inputs.prior_turn ?? null;
const allowedDecisions = new Set(["dispatch", "escalate", "done"]);
const successfulClosureOutcomes = new Set(["completed", "mitigated", "resolved", "verified"]);
const memberClosureRef =
  successfulClosureOutcomes.has(memberResult?.outcome) && validReceiptRef(memberResult?.receipt_ref)
    ? memberResult.receipt_ref
    : null;
const foldedClosureRef = validReceiptRef(caseState.resolution_evidence_ref)
  ? caseState.resolution_evidence_ref
  : null;
const base = {
  schema: "runx.incident.turn.v1",
  case_id: inputs.case_id,
  turn: Number.isInteger(caseState.turn) ? caseState.turn + 1 : 1,
  driver_id: inputs.driver_id,
  objective,
  severity: caseState.severity ?? null,
};

let result;
const rosterError = validateRoster(roster);
if (!inputs.case_id || !inputs.driver_id || !allowedObjectives.has(objective)) {
  result = refused(base, "case_id, driver_id, and a supported incident objective are required");
} else if (!caseState.declared || !caseState.severity || !caseState.scope) {
  result = refused(base, "incident must be declared with severity and bounded scope");
} else if (rosterError) {
  result = refused(base, rosterError);
} else if (!allowedDecisions.has(decision.decision)) {
  result = refused(base, `unsupported ops-desk decision ${decision.decision ?? "missing"}`);
} else if (memberResult?.outcome === "delivered" && !validReceiptRef(memberResult?.receipt_ref)) {
  result = refused(base, "communication cannot be marked delivered without a linked send receipt");
} else if (
  objective === "assign" &&
  !asArray(roster).some(
    (entry) => entry.role === caseState.named_owner || entry.principal === caseState.named_owner,
  )
) {
  result = {
    incident_turn: {
      ...base,
      status: "needs_agent",
      dispatch: null,
      escalation: { lane: "human:incident-reviewer", reason: "assign requires a named roster owner" },
      named_run: null,
      reason: "assign requires a named roster owner in folded case_state",
    },
  };
} else if (
  objective === "resolve" &&
  !memberClosureRef &&
  !foldedClosureRef
) {
  result = refused(base, "resolve requires linked resolution evidence");
} else if (objective === "send") {
  const pending = caseState.pending_escalation ?? {};
  const handoff = pending.proposed_handoff ?? null;
  const comms = rosterEntry(roster, "comms_lead");
  const matchedApproval =
    approval?.principal && approval?.reason && comms?.principal && approval.principal === comms.principal;
  const handoffValid =
    handoff &&
    pending.status === "awaiting_approval" &&
    pending.lane === "human:incident-reviewer" &&
    ["send-as", "slack-notify"].includes(handoff.skill) &&
    handoff.skill === comms?.skill &&
    (handoff.runner ?? "plan") === "plan" &&
    handoff.principal === comms?.principal &&
    handoff.channel &&
    handoff.audience &&
    /^sha256:[0-9a-f]{64}$/i.test(handoff.content_digest ?? "");
  const priorTurnValid =
    priorTurn?.status === "awaiting_approval" &&
    priorTurn?.case_id === inputs.case_id &&
    priorTurn?.turn === caseState.turn &&
    priorTurn?.named_run?.skill === handoff?.skill &&
    priorTurn?.named_run?.runner === "plan" &&
    priorTurn?.named_run?.executable === false &&
    priorTurn?.named_run?.data?.principal === handoff?.principal &&
    priorTurn?.named_run?.data?.channel === handoff?.channel &&
    JSON.stringify(priorTurn?.named_run?.data?.audience) === JSON.stringify(handoff?.audience) &&
    priorTurn?.named_run?.data?.content_digest === handoff?.content_digest;

  if (!handoffValid || !priorTurnValid) {
    result = refused(base, "send requires a roster-bound send-as or slack-notify handoff with channel, audience, and content digest");
  } else if (!matchedApproval) {
    result = {
      incident_turn: {
        ...base,
        status: "awaiting_approval",
        dispatch: null,
        escalation: {
          lane: "human:incident-reviewer",
          reason: "missing or unmatched roster approval",
          proposed_handoff: handoff,
        },
        named_run: {
          skill: handoff.skill,
          runner: "plan",
          executable: false,
          data: {
            principal: handoff.principal,
            channel: handoff.channel,
            audience: handoff.audience,
            content_digest: handoff.content_digest,
          },
        },
        reason: "send remains non-actionable until approval principal matches comms_lead",
      },
    };
  } else {
    const dispatchError = validateDispatch(decision, roster);
    if (dispatchError || decision.dispatch.member !== "comms_lead") {
      result = refused(base, dispatchError ?? "send dispatch must select comms_lead");
    } else {
      result = {
        incident_turn: {
          ...base,
          status: "advanced",
          dispatch: safeDispatch(decision),
          escalation: null,
          named_run: {
            skill: handoff.skill,
            runner: "plan",
            executable: true,
            data: {
              principal: handoff.principal,
              channel: handoff.channel,
              audience: handoff.audience,
              content_digest: handoff.content_digest,
            },
          },
          approval_principal: approval.principal,
          delivery_receipt_ref: memberResult?.outcome === "delivered" ? memberResult.receipt_ref : null,
          reason: decision.reason ?? "roster-matched approval permits the named governed handoff",
        },
      };
    }
  }
} else {
  const dispatchError = decision.decision === "dispatch" ? validateDispatch(decision, roster) : null;
  if (dispatchError) {
    result = refused(base, dispatchError);
  } else if (decision.decision === "escalate") {
    result = {
      incident_turn: {
        ...base,
        status: "awaiting_approval",
        dispatch: null,
        escalation: decision.escalation ?? { lane: "human:incident-reviewer" },
        named_run: null,
        reason: decision.reason ?? "incident decision requires human review",
      },
    };
  } else if (decision.decision === "done") {
    result = objective !== "resolve"
      ? refused(base, `objective ${objective} cannot resolve the incident case`)
      : {
          incident_turn: {
            ...base,
            status: "resolved",
            dispatch: null,
            escalation: null,
            named_run: null,
            resolution_receipt_ref: memberClosureRef ?? foldedClosureRef,
            reason: decision.reason ?? "incident objective is complete with linked evidence",
          },
        };
  } else {
    const owner = objective === "assign"
      ? asArray(roster).find(
          (entry) => entry.role === caseState.named_owner || entry.principal === caseState.named_owner,
        )
      : null;
    if (owner && decision.dispatch.member !== owner.role) {
      result = refused(base, "assign dispatch does not match the named roster owner");
    } else {
    result = {
      incident_turn: {
        ...base,
        status: "advanced",
        dispatch: safeDispatch(decision),
        escalation: null,
        named_run: null,
        reason: decision.reason ?? "incident turn advanced within the fixed roster",
      },
    };
    }
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
