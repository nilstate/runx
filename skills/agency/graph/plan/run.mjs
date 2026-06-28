import fs from "node:fs";

// The trusted turn planner. It takes ops-desk's dispatch decision but the
// measurable gate overrides it: if a cumulative cap is breached the turn fails
// regardless of what the model proposed (trusted structure, the model only
// supplies the reason). It also builds the single per-turn event whose append is
// the contention lease: the idempotency key is per driver, so two drivers racing
// the same turn hit a hard version conflict rather than replaying each other.

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

// Trusted structure, not the model, owns the roster boundary. A dispatch must name
// a member that is in the roster, match that role's declared skill, and request
// only scopes within the role's ceiling. Returns a reason string if violated.
function rosterViolation(decision, roster) {
  if (!decision || decision.decision !== "dispatch") return null;
  const target = decision.dispatch ?? {};
  const member = (Array.isArray(roster) ? roster : []).find((entry) => entry.role === target.member);
  if (!member) return `dispatch names member "${target.member}" which is not in the roster`;
  if (target.skill && member.skill && target.skill !== member.skill) {
    return `dispatch skill "${target.skill}" does not match roster skill "${member.skill}" for role "${target.member}"`;
  }
  const ceiling = Array.isArray(member.scope) ? member.scope : [];
  const needed = Array.isArray(target.needed_scope) ? target.needed_scope : [];
  const over = needed.filter((scope) => !ceiling.includes(scope));
  if (over.length) {
    return `dispatch needs scope ${JSON.stringify(over)} beyond role "${target.member}" ceiling ${JSON.stringify(ceiling)}`;
  }
  return null;
}

const inputs = readInputs();
const reduction = inputs.reduction ?? {};
const caseState = reduction.case_state ?? {};
const overLimits = caseState.over_limits ?? {};
const driverId = inputs.driver_id ?? "driver";
const caseId = inputs.case_id ?? caseState.case_id ?? "case";
const memberResult = inputs.member_result ?? null;
const turnNo = (reduction.turn_no ?? 0) + 1;
const expectedVersion = reduction.expected_version ?? 0;

const breached = Object.entries(overLimits)
  .filter(([, value]) => value === true)
  .map(([key]) => key);

let decision = breached.length
  ? { decision: "failed", reason: `limit reached: ${breached.join(", ")}` }
  : inputs.decision ?? { decision: "escalate", reason: "no decision returned" };

// An out-of-charter dispatch escalates to a human rather than running.
const violation = rosterViolation(decision, reduction.roster);
if (violation) {
  decision = {
    decision: "escalate",
    reason: violation,
    escalation: { to: "human", trigger: "out_of_charter", ask: violation, approval_prompt: null },
  };
}

const choice = decision.decision;
const payload = { driver_id: driverId, turn: turnNo, decision: choice, predicates: overLimits };
if (memberResult) payload.member_result = memberResult;
if (choice === "dispatch") {
  payload.dispatch = decision.dispatch ?? null;
} else if (choice === "escalate") {
  payload.escalation = decision.escalation ?? null;
} else {
  payload.resolution = decision.resolution ?? { reason: decision.reason ?? choice };
}

const statusByChoice = {
  dispatch: "advanced",
  escalate: "awaiting_approval",
  done: "resolved",
  failed: "failed",
};
const nextByChoice = {
  dispatch: "run the named member, then advance with its member_result",
  escalate: "resolve the escalation, then advance",
  done: "case closed",
  failed: "case closed",
};

const agency_turn = {
  schema: "runx.agency.turn.v1",
  status: statusByChoice[choice] ?? "advanced",
  case_id: caseId,
  turn: turnNo,
  dispatch: choice === "dispatch" ? payload.dispatch : null,
  approval_prompt:
    choice === "escalate" ? payload.escalation?.approval_prompt ?? payload.escalation?.ask ?? null : null,
  resolution: choice === "done" || choice === "failed" ? payload.resolution : null,
  predicates: overLimits,
  reason: decision.reason ?? decision.dispatch?.reason ?? null,
  next: nextByChoice[choice] ?? "advance",
};

process.stdout.write(
  `${JSON.stringify(
    {
      turn_event: { type: "turn", payload },
      expected_version: expectedVersion,
      idempotency_key: `${caseId}:turn:${turnNo}:${driverId}`,
      agency_turn,
    },
    null,
    2,
  )}\n`,
);
