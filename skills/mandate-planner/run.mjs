function parseInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    objective: process.env.RUNX_INPUT_OBJECTIVE ?? "",
    proposed_charter: parseJsonEnv("PROPOSED_CHARTER", {}),
    authority_grant: parseJsonEnv("AUTHORITY_GRANT", {}),
  };
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function fail(reason, data = {}) {
  const output = {
    decision: {
      eligible: false,
      route: "needs_agent",
      reason,
    },
    refusal: {
      reason,
      human_approval_lane: "needs_agent",
      ...data,
    },
    handoff: {
      downstream_step: "agency.open",
      dispatch: "separate governed run by naming",
      effect: "none",
      note: "mandate-planner stopped before emitting a recommended_charter",
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(2);
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function asFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${label} must be a finite number`);
  return n;
}

function normalizeRole(role) {
  return String(role ?? "").trim().toLowerCase();
}

function measurableDoneCheck(value) {
  const text = String(value ?? "").trim();
  if (text.length < 12) return false;
  return /\b(pass|passes|deliver|delivered|merged|reviewed|approved|receipt|test|tests|published|validated|verified|closed|complete|completed)\b/i.test(text);
}

function main() {
  const inputs = parseInputs();
  const objective = String(inputs.objective ?? "").trim();
  const proposed = inputs.proposed_charter ?? {};
  const grant = inputs.authority_grant ?? {};

  if (!objective) fail("objective is required");

  const roster = asArray(proposed.candidate_roster, "proposed_charter.candidate_roster");
  if (roster.length === 0) fail("candidate_roster must name at least one role");

  const grantedRoles = new Set(asArray(grant.granted_roles, "authority_grant.granted_roles").map(normalizeRole));
  if (grantedRoles.size === 0) fail("authority_grant.granted_roles must include at least one role");

  const requestedLimits = proposed.requested_limits ?? {};
  const requestedSpend = asFiniteNumber(requestedLimits.spend, "proposed_charter.requested_limits.spend");
  const requestedTurns = asFiniteNumber(requestedLimits.max_turns, "proposed_charter.requested_limits.max_turns");
  const grantedSpend = asFiniteNumber(grant.granted_spend, "authority_grant.granted_spend");
  const grantedTurns = asFiniteNumber(grant.max_turns, "authority_grant.max_turns");

  const roleTraces = roster.map((member, index) => {
    const role = normalizeRole(member.role);
    if (!role) fail(`candidate_roster[${index}].role is required`);
    if (!grantedRoles.has(role)) {
      fail(`role '${role}' is outside authority_grant.granted_roles`, {
        denied_role: role,
        granted_roles: [...grantedRoles],
      });
    }
    return {
      role,
      skill: String(member.skill ?? "").trim(),
      scope: String(member.scope ?? "").trim(),
      granted: true,
      source: `candidate_roster[${index}]`,
    };
  });

  if (requestedSpend > grantedSpend) {
    fail(`requested spend ${requestedSpend} exceeds granted spend ${grantedSpend}`, {
      requested_spend: requestedSpend,
      granted_spend: grantedSpend,
    });
  }
  if (requestedTurns > grantedTurns) {
    fail(`requested max_turns ${requestedTurns} exceeds granted max_turns ${grantedTurns}`, {
      requested_max_turns: requestedTurns,
      granted_max_turns: grantedTurns,
    });
  }
  if (!measurableDoneCheck(proposed.done_check)) {
    fail("done_check is missing or not measurable", {
      done_check: proposed.done_check ?? null,
    });
  }

  const recommended = {
    scopes: roleTraces.map((trace) => ({
      role: trace.role,
      skill: trace.skill,
      scope: trace.scope,
    })),
    spend: requestedSpend,
    max_turns: requestedTurns,
    counterparty: String(proposed.counterparty ?? grant.counterparty ?? "operator-approved agency driver"),
    done_check: String(proposed.done_check).trim(),
  };

  const output = {
    decision: {
      eligible: true,
      route: "dispatch-by-naming",
      reason: "Proposed charter is inside the authority grant and has a measurable done_check.",
    },
    recommended_charter: recommended,
    evidence: {
      objective,
      role_traces: roleTraces,
      limits: {
        requested_spend: requestedSpend,
        granted_spend: grantedSpend,
        requested_max_turns: requestedTurns,
        granted_max_turns: grantedTurns,
      },
      done_check: recommended.done_check,
    },
    handoff: {
      downstream_step: "agency.open",
      dispatch: "separate governed run by naming",
      effect: "none",
      note: "Use recommended_charter as data for a later agency.open run; mandate-planner does not call it.",
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
