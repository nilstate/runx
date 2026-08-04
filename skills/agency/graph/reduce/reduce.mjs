// Replay the durable case stream, then apply the in-flight member result so the
// next decision sees it before the planner persists it in the next turn event.
export default function reduce(inputs) {
  const entries = Array.isArray(inputs.events) ? inputs.events : [];
  const memberResult = inputs.member_result ?? null;
  const state = {
    agency_ref: "",
    mandate: "",
    roster: [],
    limits: {},
    status: "absent",
    turn: 0,
    acts: 0,
    spent: { amount: 0, currency: null },
    members_used: [],
    last_action: null,
    pending_escalation: null,
  };
  let version = 0;
  const applyResult = (result) => {
    if (!result) return;
    state.acts += 1;
    if (result.member && !state.members_used.includes(result.member)) state.members_used.push(result.member);
    if (result.spend && typeof result.spend.amount === "number") {
      state.spent.amount += result.spend.amount;
      state.spent.currency = state.spent.currency ?? result.spend.currency ?? null;
    }
  };

  for (const entry of entries) {
    if (typeof entry.version === "number") version = entry.version;
    const event = entry.event ?? {};
    const payload = event.payload ?? {};
    if (event.type === "opened") {
      state.agency_ref = payload.agency_ref ?? "";
      state.mandate = payload.mandate ?? "";
      state.roster = Array.isArray(payload.roster) ? payload.roster : [];
      state.limits = payload.limits ?? {};
      state.status = "working";
    } else if (event.type === "turn") {
      if (typeof payload.turn === "number") state.turn = payload.turn;
      applyResult(payload.member_result);
      if (payload.decision === "dispatch") {
        state.status = "working";
        state.last_action = payload.dispatch?.task ?? null;
        state.pending_escalation = null;
      } else if (payload.decision === "escalate") {
        state.status = "awaiting";
        state.pending_escalation = payload.escalation ?? null;
        state.last_action = payload.escalation?.ask ?? null;
      } else if (payload.decision === "done") {
        state.status = "resolved";
        state.last_action = payload.resolution?.reason ?? null;
      } else if (payload.decision === "failed") {
        state.status = "failed";
        state.last_action = payload.resolution?.reason ?? null;
      }
    } else if (event.type === "approved" || event.type === "denied") {
      state.pending_escalation = null;
      state.status = "working";
      state.last_action = `${event.type}: ${payload.ask ?? payload.request_id ?? "escalation"}`;
    }
  }

  applyResult(memberResult);
  if (memberResult) state.last_action = `member ${memberResult.member ?? "?"} returned: ${memberResult.outcome ?? "done"}`;
  const maxActs = state.limits.max_turns ?? null;
  const maxSpend = state.limits.spend?.max_per_run?.amount ?? null;
  const over_limits = {
    acts_over_cap: typeof maxActs === "number" ? state.acts >= maxActs : false,
    spend_over_cap: typeof maxSpend === "number" ? state.spent.amount > maxSpend : false,
    ttl_expired: false,
  };
  return {
    reduction: {
      case_state: {
        case_id: inputs.case_id ?? null,
        agency_ref: state.agency_ref,
        status: state.status,
        mandate: state.mandate,
        turn: state.turn,
        last_action: state.last_action,
        pending_escalation: state.pending_escalation,
        members_used: state.members_used,
        spent: state.spent,
        acts: state.acts,
        over_limits,
      },
      mandate: state.mandate,
      roster: state.roster,
      limits: state.limits,
      agency_ref: state.agency_ref,
      expected_version: version,
      turn_no: state.turn,
    },
  };
}
