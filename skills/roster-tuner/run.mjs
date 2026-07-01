#!/usr/bin/env node

import fs from "node:fs";

function main() {
  const inputs = readInputs();
  const caseId = requiredString(inputs.case_id, "case_id");
  const dataSourceRef = requiredString(inputs.data_source_ref, "data_source_ref");
  const resource = requiredString(inputs.resource, "resource");
  const aggregateId = requiredString(inputs.aggregate_id, "aggregate_id");
  const expectedVersion = numberValue(inputs.expected_version, "expected_version");
  const idempotencyKey = requiredString(
    inputs.idempotency_key,
    "idempotency_key",
  );
  const roster = rosterEntries(inputs.roster);
  const norms = normsValue(inputs.performance_norms);
  const schemaVersion = requiredString(
    inputs.agency_event_schema_version,
    "agency_event_schema_version",
  );
  const signals = signalsValue(inputs.folded_signals);

  const refusalResult = refusalFor({
    caseId,
    aggregateId,
    resource,
    schemaVersion,
    roster,
    norms,
    signals,
  });
  if (refusalResult) {
    process.stdout.write(`${JSON.stringify(refusal(refusalResult, { caseId, aggregateId, expectedVersion, schemaVersion, norms }), null, 2)}\n`);
    process.exitCode = 64;
    return;
  }

  const ranked = rankMembers(signals, norms);
  if (ranked.length !== 1) {
    const refusalReason =
      ranked.length === 0
        ? "No member crossed both refusal and completion norms, so the bounded roster change is empty."
        : `${ranked.length} members crossed both norms; the bounded roster change must name exactly one, so the run seals a refusal.`;
    process.stdout.write(
      `${JSON.stringify(
        refusal(refusalReason, {
          caseId,
          aggregateId,
          expectedVersion,
          schemaVersion,
          norms,
          signals,
        }),
        null,
        2,
      )}\n`,
    );
    process.exitCode = 64;
    return;
  }

  const target = ranked[0];
  const replacement = pickReplacement(roster, target, signals);
  if (!replacement) {
    const refusalReason = `Member ${target.member} crosses both norms but no skill-matched peer remains in the roster, so the bounded swap is unsafe.`;
    process.stdout.write(
      `${JSON.stringify(
        refusal(refusalReason, {
          caseId,
          aggregateId,
          expectedVersion,
          schemaVersion,
          norms,
          signals,
        }),
        null,
        2,
      )}\n`,
    );
    process.exitCode = 64;
    return;
  }

  const result = {
    decision: {
      schema: "runx.roster.tune.v1",
      underperformer: true,
      member_to_remove: target.member,
      replacement_candidate: replacement.member,
      reason: `Member ${target.member} crossed the refusal rate ${signals.refusal_rates[target.member].toFixed(2)} (above ${norms.refusal_threshold}) and completion time ${signals.completion_times_x_case_mean[target.member].toFixed(2)}x (above ${norms.completion_time_threshold}x the case mean); the replacement ${replacement.member} shares the ${replacement.skill} skill with ${signals.refusal_rates[replacement.member].toFixed(2)} refusal rate, so the bounded swap preserves the required skill set.`,
      evidence: {
        case_id: caseId,
        aggregate_id: aggregateId,
        expected_version: expectedVersion,
        schema_version: schemaVersion,
        folded_refusal_rates: stringifyRates(signals.refusal_rates),
        folded_completion_times_x_case_mean: stringifyTimes(
          signals.completion_times_x_case_mean,
        ),
        norms_applied: norms,
      },
    },
    append_event: {
      schema: "runx.case.append.v1",
      resource,
      aggregate_id: aggregateId,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
      side_effects: "none",
      data_source_ref: dataSourceRef,
      event: {
        kind: "roster_tuning_decision",
        underperformer: true,
        member_to_remove: target.member,
        replacement_candidate: replacement.member,
        reason: "folded refusal and completion signals justify the bounded swap",
        case_id: caseId,
        schema_version: schemaVersion,
      },
    },
    refusal: { reason: null },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function refusal(reason, { caseId, aggregateId, expectedVersion, schemaVersion, norms, signals }) {
  return {
    decision: {
      schema: "runx.roster.tune.v1",
      underperformer: false,
      member_to_remove: null,
      replacement_candidate: null,
      reason,
      evidence: {
        case_id: caseId,
        aggregate_id: aggregateId,
        expected_version: expectedVersion,
        schema_version: schemaVersion,
        folded_refusal_rates: signals ? stringifyRates(signals.refusal_rates) : {},
        folded_completion_times_x_case_mean: signals
          ? stringifyTimes(signals.completion_times_x_case_mean)
          : {},
        norms_applied: norms,
      },
    },
    append_event: null,
    refusal: { reason },
  };
}

function refusalFor({ caseId, aggregateId, resource, schemaVersion, roster, norms, signals }) {
  if (caseId !== aggregateId) {
    return `aggregate_id (${aggregateId}) must equal case_id (${caseId}).`;
  }
  if (resource !== "agency_cases") {
    return `resource must equal agency_cases; received ${resource}.`;
  }
  if (schemaVersion !== "agency.case.event.v1") {
    return `agency_event_schema_version must equal agency.case.event.v1; received ${schemaVersion}.`;
  }
  if (roster.length < norms.min_roster_size) {
    return `roster is smaller than min_roster_size (${norms.min_roster_size}).`;
  }
  if (!signals) {
    return "folded_signals must be supplied by the case projection before any decision is emitted.";
  }
  for (const entry of roster) {
    if (typeof signals.refusal_rates[entry.member] !== "number") {
      return `folded_signals.refusal_rates is missing member ${entry.member}.`;
    }
    if (typeof signals.completion_times_x_case_mean[entry.member] !== "number") {
      return `folded_signals.completion_times_x_case_mean is missing member ${entry.member}.`;
    }
  }
  return null;
}

function rosterEntries(raw) {
  if (!Array.isArray(raw)) fail("roster must be an array");
  return raw.map((entry, index) => {
    const member = requiredString(
      entry && entry.member,
      `roster[${index}].member`,
    );
    const skill = requiredString(
      entry && entry.skill,
      `roster[${index}].skill`,
    );
    return { member, skill };
  });
}

function normsValue(raw) {
  const obj = objectValue(raw, "performance_norms");
  return {
    refusal_threshold: numberValue(
      obj.refusal_threshold,
      "performance_norms.refusal_threshold",
    ),
    completion_time_threshold: numberValue(
      obj.completion_time_threshold,
      "performance_norms.completion_time_threshold",
    ),
    min_roster_size: numberValue(
      obj.min_roster_size,
      "performance_norms.min_roster_size",
    ),
  };
}

function signalsValue(raw) {
  const obj = objectValue(raw, "folded_signals");
  const refusal = obj.refusal_rates || {};
  const time = obj.completion_times_x_case_mean || {};
  return {
    refusal_rates: { ...refusal },
    completion_times_x_case_mean: { ...time },
  };
}

function rankMembers(signals, norms) {
  const out = [];
  for (const member of Object.keys(signals.refusal_rates)) {
    const refusal = signals.refusal_rates[member];
    const time = signals.completion_times_x_case_mean[member];
    if (refusal > norms.refusal_threshold && time > norms.completion_time_threshold) {
      out.push({ member, refusal, time });
    }
  }
  out.sort((a, b) => b.refusal - a.refusal || b.time - a.time);
  return out;
}

function pickReplacement(roster, target, signals) {
  // `target` from rankMembers only carries {member, refusal, time}; resolve the
  // target's skill from the roster snapshot so the skill-match search has a
  // concrete value to compare against instead of an undefined `target.skill`.
  const targetEntry = roster.find((entry) => entry.member === target.member);
  const targetSkill = targetEntry ? targetEntry.skill : null;
  if (!targetSkill) return null;

  let best = null;
  for (const entry of roster) {
    if (entry.member === target.member) continue;
    if (entry.skill !== targetSkill) continue;
    const refusal = signals.refusal_rates[entry.member];
    if (refusal === undefined || refusal === null) continue;
    const targetRefusal = signals.refusal_rates[target.member];
    if (targetRefusal === undefined || targetRefusal === null) continue;
    if (refusal >= targetRefusal) continue;
    if (!best || refusal < signals.refusal_rates[best.member]) best = entry;
  }
  return best;
}

function stringifyRates(rates) {
  const out = {};
  for (const k of Object.keys(rates)) out[k] = Number(Number(rates[k]).toFixed(2));
  return out;
}

function stringifyTimes(times) {
  const out = {};
  for (const k of Object.keys(times)) out[k] = Number(Number(times[k]).toFixed(2));
  return out;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    case_id: process.env.RUNX_INPUT_CASE_ID,
    data_source_ref: process.env.RUNX_INPUT_DATA_SOURCE_REF,
    store_id: process.env.RUNX_INPUT_STORE_ID,
    resource: process.env.RUNX_INPUT_RESOURCE,
    aggregate_id: process.env.RUNX_INPUT_AGGREGATE_ID,
    expected_version: numberFromEnv(process.env.RUNX_INPUT_EXPECTED_VERSION),
    idempotency_key: process.env.RUNX_INPUT_IDEMPOTENCY_KEY,
    roster: parseInputValue(process.env.RUNX_INPUT_ROSTER),
    performance_norms: parseInputValue(process.env.RUNX_INPUT_PERFORMANCE_NORMS),
    folded_signals: parseInputValue(process.env.RUNX_INPUT_FOLDED_SIGNALS),
    agency_event_schema_version: process.env.RUNX_INPUT_AGENCY_EVENT_SCHEMA_VERSION,
    operator_context: process.env.RUNX_INPUT_OPERATOR_CONTEXT,
  };
}

function numberFromEnv(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return num;
}

function parseInputValue(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function requiredString(value, name) {
  const text = stringValue(value);
  if (!text) fail(`${name} is required`);
  return text;
}

function numberValue(value, name) {
  if (value === undefined || value === null || value === "") {
    fail(`${name} is required`);
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) fail(`${name} must be a number`);
  return num;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

main();
