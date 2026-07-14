function readJsonInput(name, fallback = null) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readStringInput(name, fallback = "") {
  const value = readJsonInput(name, fallback);
  return typeof value === "string" ? value : fallback;
}

const caseId = readStringInput("CASE_ID", "");
const driverId = readStringInput("DRIVER_ID", "");
const incidentObjective = readStringInput("INCIDENT_OBJECTIVE", "");
const caseState = readJsonInput("CASE_STATE", {});
const roster = readJsonInput("ROSTER", []);
const approval = readJsonInput("APPROVAL", null);
const memberResult = readJsonInput("MEMBER_RESULT", null);

const turn = Number(caseState?.turn ?? 0) + 1;
const sourceAlert = caseState?.source_alert ?? null;
const severity = String(caseState?.severity ?? "unknown");
const channel = caseState?.channel ?? "#incidents";
const audience = caseState?.audience ?? { kind: "incident-stakeholders", incident: caseId };
const contentDigest = caseState?.content_digest ?? "";

function rosterEntries() {
  if (Array.isArray(roster)) return roster;
  if (Array.isArray(roster?.members)) return roster.members;
  return [];
}

function principalFor(role) {
  const entry = rosterEntries().find((item) => item.role === role || item.principal === role);
  return entry?.principal ?? null;
}

function hasRosterPrincipal(principal) {
  return rosterEntries().some((item) => item.principal === principal || item.role === principal);
}

function namedCommsRun() {
  const external = caseState?.audience?.external === true || caseState?.send_class === "stakeholder";
  const skill = external ? "governed-outbound" : "slack-notify";
  return {
    skill,
    runner: external ? "governed-outbound" : "plan",
    principal: principalFor("comms_lead") ?? "incident:comms_lead",
    channel,
    audience,
    content_digest: contentDigest,
    source_alert_ref: sourceAlert?.ref ?? sourceAlert?.id ?? null,
    command_hint: external
      ? "runx skill governed-outbound -i url=<source> -i channel=<channel> -i principal=<principal>"
      : "runx skill slack-notify -i channel=<channel> --input-json content=<digest-bound-content>",
  };
}

function turnPacket(status, reason, extra = {}) {
  const incidentTurn = {
    schema: "runx.incident_commander.turn.v1",
    status,
    case_id: caseId,
    turn,
    driver_id: driverId,
    objective: incidentObjective,
    incident_severity: severity,
    dispatch: extra.dispatch ?? null,
    escalation: extra.escalation ?? null,
    named_run: extra.named_run ?? null,
    reason,
    source_alert: sourceAlert,
    approval: approval
      ? {
          principal: approval.principal ?? null,
          reason: approval.reason ?? null,
          matched_roster: approval.principal ? hasRosterPrincipal(approval.principal) : false,
        }
      : null,
    member_result: memberResult
      ? {
          outcome: memberResult.outcome ?? null,
          receipt_ref: memberResult.receipt_ref ?? null,
        }
      : null,
    prior_awaiting_approval: extra.prior_awaiting_approval ?? null,
  };
  return {
    act_decision: status,
    act_reason: `status=${status} reason=${reason} case=${caseId} turn=${turn}`,
    act_target_ref: `runx:incident:${caseId}#turn-${turn}`,
    incident_turn: incidentTurn,
  };
}

let packet;

if (!caseId || !driverId || !incidentObjective) {
  packet = turnPacket("needs_agent", "missing case_id, driver_id, or incident_objective");
} else if (!sourceAlert?.ref && !sourceAlert?.id) {
  packet = turnPacket("needs_agent", "missing monitor-backed source_alert on folded case_state");
} else if (incidentObjective === "send") {
  const run = namedCommsRun();
  const approvalPrincipal = approval?.principal ?? null;
  const approvalMatches = approvalPrincipal ? hasRosterPrincipal(approvalPrincipal) : false;
  if (!approvalPrincipal) {
    packet = turnPacket("awaiting_approval", "status update requires roster-matched approval before dispatch", {
      named_run: run,
      escalation: {
        lane: "incident-reviewer",
        required: true,
        reason: "missing approval",
      },
    });
  } else if (!approvalMatches) {
    packet = turnPacket("awaiting_approval", "approval principal does not match incident roster", {
      named_run: run,
      escalation: {
        lane: "incident-reviewer",
        required: true,
        reason: "unmatched approval principal",
      },
    });
  } else if (!memberResult?.receipt_ref) {
    packet = turnPacket("awaiting_approval", "approval matched; waiting for governed send receipt", {
      named_run: run,
      escalation: {
        lane: "governed-outbound",
        required: true,
        reason: "send receipt not linked yet",
      },
      prior_awaiting_approval: {
        status: "awaiting_approval",
        named_run: run,
        approval_principal: approvalPrincipal,
      },
    });
  } else {
    packet = turnPacket("delivered", "roster approval matched and governed send receipt linked", {
      named_run: run,
      dispatch: {
        lane: run.skill,
        receipt_ref: memberResult.receipt_ref,
        outcome: memberResult.outcome ?? "sent",
      },
      prior_awaiting_approval: {
        status: "awaiting_approval",
        named_run: run,
        approval_principal: approvalPrincipal,
      },
    });
  }
} else if (incidentObjective === "assign") {
  const owner = caseState?.assign_to ?? caseState?.requested_owner ?? null;
  if (!owner || !hasRosterPrincipal(owner)) {
    packet = turnPacket("needs_agent", "assign objective has no named roster owner", {
      escalation: {
        lane: "incident-reviewer",
        required: true,
        reason: "missing roster owner",
      },
    });
  } else {
    packet = turnPacket("advanced", "assignment target is present in incident roster", {
      dispatch: {
        member: owner,
        task: caseState?.assignment_task ?? "take incident responder lead",
      },
    });
  }
} else if (incidentObjective === "resolve") {
  const receiptRef = memberResult?.receipt_ref ?? caseState?.resolution_evidence?.receipt_ref ?? null;
  if (!receiptRef) {
    packet = turnPacket("needs_agent", "resolution requires linked evidence receipt");
  } else {
    packet = turnPacket("resolved", "resolution evidence receipt linked", {
      dispatch: {
        lane: "postmortem",
        receipt_ref: receiptRef,
      },
    });
  }
} else {
  packet = turnPacket("advanced", `objective ${incidentObjective} recorded for incident agency turn`);
}

process.stdout.write(`${JSON.stringify(packet)}\n`);
