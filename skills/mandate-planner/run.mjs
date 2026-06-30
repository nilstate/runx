function readJson(name, fallback) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const objective = process.env.RUNX_INPUT_OBJECTIVE || "";
const proposedCharter = readJson("PROPOSED_CHARTER", {});
const authorityGrant = readJson("AUTHORITY_GRANT", {});

const roster = Array.isArray(proposedCharter.candidate_roster) ? proposedCharter.candidate_roster : [];
const requestedLimits = proposedCharter.requested_limits || {};
const doneCheck = typeof proposedCharter.done_check === "string" ? proposedCharter.done_check.trim() : "";
const grantedRoles = new Set(Array.isArray(authorityGrant.granted_roles) ? authorityGrant.granted_roles : []);
const grantedSpend = Number(authorityGrant.granted_spend ?? 0);
const grantedTurns = Number(authorityGrant.max_turns ?? 0);
const requestedSpend = Number(requestedLimits.spend ?? 0);
const requestedTurns = Number(requestedLimits.max_turns ?? 0);

const roleTrace = roster.map((member) => ({
  role: member.role,
  skill: member.skill || null,
  scope: member.scope || null,
  present_in_authority_grant: grantedRoles.has(member.role)
}));

const absentRoles = roleTrace.filter((entry) => !entry.present_in_authority_grant).map((entry) => entry.role);
const measurableDoneCheck = doneCheck.length > 0 && /(verify|measur|metric|pass|complete|acceptance|receipt|assert|check)/i.test(doneCheck);

const blockers = [];
if (roster.length === 0) blockers.push("missing_roster: proposed_charter.candidate_roster is empty");
if (absentRoles.length > 0) blockers.push(`role_outside_grant: ${absentRoles.join(", ")} not present in authority_grant.granted_roles`);
if (requestedSpend > grantedSpend) blockers.push(`spend_above_grant: requested ${requestedSpend} exceeds granted ${grantedSpend}`);
if (requestedTurns > grantedTurns) blockers.push(`turns_above_grant: requested ${requestedTurns} exceeds granted ${grantedTurns}`);
if (!measurableDoneCheck) blockers.push("missing_measurable_done_check: proposed_charter.done_check is absent or not measurable");

const eligible = blockers.length === 0;
const decision = {
  eligible,
  reason: eligible
    ? `eligible: ${roster.length} roster role(s), spend ${requestedSpend}/${grantedSpend}, turns ${requestedTurns}/${grantedTurns}, and done_check are inside the authority grant`
    : blockers.join("; ")
};

let recommended_charter = null;
let dispatch_target = null;
let escalation = {
  lane: "none",
  reason: "charter is inside grant and may be handed to agency.open by a separate governed run"
};

if (eligible) {
  recommended_charter = {
    scopes: roster.map((member) => ({
      role: member.role,
      skill: member.skill,
      scope: member.scope
    })),
    spend: requestedSpend,
    max_turns: requestedTurns,
    counterparty: "agency.open",
    done_check: doneCheck
  };
  dispatch_target = {
    mode: "dispatch-by-naming",
    skill: "agency.open",
    note: "This validator emits data only; a downstream driver or operator separately invokes agency.open from the recommended charter.",
    mapping: {
      roster: "recommended_charter.scopes",
      limits: {
        spend: "recommended_charter.spend",
        max_turns: "recommended_charter.max_turns"
      },
      objective: "objective",
      done_check: "recommended_charter.done_check"
    }
  };
} else {
  escalation = {
    lane: "human_approval",
    status: "needs_agent",
    reason: "charter is ambiguous or outside grant; do not emit a recommended_charter"
  };
}

const packet = {
  schema: "runx.agency.mandate_planner.v1",
  objective,
  decision,
  recommended_charter,
  escalation,
  dispatch_target,
  evidence: {
    role_trace: roleTrace,
    requested_limits: {
      spend: requestedSpend,
      max_turns: requestedTurns
    },
    authority_limits: {
      granted_spend: grantedSpend,
      max_turns: grantedTurns,
      granted_roles: Array.from(grantedRoles)
    },
    done_check: doneCheck,
    blockers
  },
  invariants: {
    opens_case: false,
    mints: false,
    holds_state: false,
    enforces_limit: false,
    calls_agency_open: false
  }
};

process.stdout.write(`${JSON.stringify(packet)}\n`);
