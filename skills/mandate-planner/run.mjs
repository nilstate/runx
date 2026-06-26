import fs from "node:fs";

const inputs = readInputs();
const objective = requiredString(inputs.objective, "objective");
const proposed = objectValue(inputs.proposed_charter, "proposed_charter");
const grant = objectValue(inputs.authority_grant, "authority_grant");

const roster = arrayValue(proposed.candidate_roster, "proposed_charter.candidate_roster")
  .map((member, index) => normalizeRosterMember(member, index));
const limits = objectValue(proposed.requested_limits, "proposed_charter.requested_limits");
const requestedSpend = finiteNumber(limits.spend, "proposed_charter.requested_limits.spend");
const requestedTurns = finiteNumber(limits.max_turns, "proposed_charter.requested_limits.max_turns");
const doneCheck = stringValue(proposed.done_check);
const counterparty = stringValue(proposed.counterparty) || "operator";

const grantedRoles = stringArray(grant.granted_roles, "authority_grant.granted_roles");
const grantedSpend = finiteNumber(grant.granted_spend, "authority_grant.granted_spend");
const grantedTurns = finiteNumber(grant.max_turns, "authority_grant.max_turns");

const roleChecks = roster.map((member) => ({
  role: member.role,
  skill: member.skill,
  scope: member.scope,
  granted: grantedRoles.includes(member.role),
  source: "candidate_roster",
}));

const limitChecks = [
  {
    name: "spend",
    requested: requestedSpend,
    granted: grantedSpend,
    within_grant: requestedSpend <= grantedSpend,
  },
  {
    name: "max_turns",
    requested: requestedTurns,
    granted: grantedTurns,
    within_grant: requestedTurns <= grantedTurns,
  },
];

const blockedReasons = [];
const missingRoles = roleChecks.filter((check) => !check.granted).map((check) => check.role);
if (missingRoles.length > 0) {
  blockedReasons.push({
    code: "role_outside_grant",
    reason: `Roster role(s) outside authority grant: ${missingRoles.join(", ")}.`,
  });
}

const overLimits = limitChecks.filter((check) => !check.within_grant);
if (overLimits.length > 0) {
  blockedReasons.push({
    code: "limit_exceeds_grant",
    reason: `Requested limit(s) exceed grant: ${overLimits.map((check) => check.name).join(", ")}.`,
  });
}

if (!isMeasurableDoneCheck(doneCheck)) {
  blockedReasons.push({
    code: "missing_done_check",
    reason: "The proposed charter does not include a measurable done_check predicate.",
  });
}

const eligible = blockedReasons.length === 0;
const reasonCode = eligible ? "eligible" : blockedReasons[0].code;
const reason = eligible
  ? "The proposed charter is inside the authority grant and has a measurable done-check."
  : blockedReasons.map((entry) => entry.reason).join(" ");

const recommendedCharter = eligible
  ? {
      objective,
      roster: roster.map((member) => ({
        role: member.role,
        skill: member.skill,
        scope: member.scope,
      })),
      scopes: [...new Set(roster.flatMap((member) => member.scope))],
      spend: requestedSpend,
      max_turns: requestedTurns,
      counterparty,
      done_check: doneCheck,
      authority_trace: {
        granted_roles: grantedRoles,
        granted_spend: grantedSpend,
        granted_max_turns: grantedTurns,
      },
    }
  : null;

const mandatePlan = {
  schema: "runx.agency.mandate_plan.v1",
  objective,
  decision: {
    eligible,
    reason,
    reason_code: reasonCode,
  },
  recommended_charter: recommendedCharter,
  escalation: eligible
    ? {
        lane: "none",
        reason: null,
        needs_agent: false,
      }
    : {
        lane: "human_approval",
        reason,
        needs_agent: true,
      },
  trace: {
    role_checks: roleChecks,
    limit_checks: limitChecks,
    done_check: doneCheck,
    refused_reasons: blockedReasons,
  },
  dispatch_by_naming: {
    downstream_run: "agency.open",
    effect_status: "not_called",
    mapping: eligible
      ? {
          mandate: "recommended_charter.objective",
          roster: "recommended_charter.roster",
          limits: {
            spend: "recommended_charter.spend",
            max_turns: "recommended_charter.max_turns",
          },
          done_check: "recommended_charter.done_check",
        }
      : {},
    note: "A downstream driver or operator must issue a separate governed agency.open run by naming this verdict.",
  },
};

const result = {
  mandate_plan: mandatePlan,
  decision: mandatePlan.decision,
  recommended_charter: recommendedCharter,
  verdict: eligible
    ? `eligible: ${roster.length} role(s), spend ${requestedSpend}, max_turns ${requestedTurns}`
    : `blocked: ${reasonCode}`,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizeRosterMember(value, index) {
  const member = objectValue(value, `proposed_charter.candidate_roster[${index}]`);
  const scope = Array.isArray(member.scope)
    ? member.scope.map((entry) => requiredString(entry, `proposed_charter.candidate_roster[${index}].scope[]`))
    : [requiredString(member.scope, `proposed_charter.candidate_roster[${index}].scope`)];
  return {
    role: requiredString(member.role, `proposed_charter.candidate_roster[${index}].role`),
    skill: requiredString(member.skill, `proposed_charter.candidate_roster[${index}].skill`),
    scope,
  };
}

function isMeasurableDoneCheck(value) {
  const text = stringValue(value);
  if (!text) return false;
  const normalized = text.toLowerCase();
  return /\b(when|until|metric|receipt|merged|published|delivered|verified|http 200|equals|>=|<=|==|count|status)\b/.test(normalized);
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function arrayValue(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} must be a non-empty array`);
  }
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} must be a non-empty string array`);
  }
  return value.map((entry) => requiredString(entry, `${name}[]`));
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(`${name} must be a non-negative number`);
  }
  return number;
}

function requiredString(value, name) {
  const text = stringValue(value);
  if (!text) fail(`${name} must be a non-empty string`);
  return text;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
