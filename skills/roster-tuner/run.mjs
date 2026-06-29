import fs from "node:fs";
import path from "node:path";

// Roster-tuner: a cli-tool runner that reads sealed agency case events,
// folds per-member metrics, grades against norms, decides underperformers,
// and appends a judgment event to the case stream.

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

const inputs = readInputs();
const roster = Array.isArray(inputs.roster) ? inputs.roster : [];
const norms = inputs.performance_norms ?? {};
const declaredVersion = String(inputs.agency_event_schema_version ?? "1");
const caseId = inputs.case_id ?? null;
const expectedVersion = inputs.expected_version ?? 0;
const idempotencyKey = inputs.idempotency_key ?? "";
const dataStoreRef = inputs.data_source_ref ?? "";
const storeId = inputs.store_id ?? "";
const resource = inputs.resource ?? "agency_cases";
const aggregateId = inputs.aggregate_id ?? caseId;

const refusalThreshold = norms.refusal_threshold ?? 0.6;
const completionTimeThreshold = norms.completion_time_threshold ?? 120;
const minRosterSize = norms.min_roster_size ?? 2;

// ─── READ EVENTS FROM DATA STORE ────────────────────────────────────────────
// Read from the local data store (data.local JSON fixture or pre-populated events)
let events = [];

// Try to read from inline events (for harness fixtures)
if (Array.isArray(inputs.events)) {
  events = inputs.events;
} else {
  // Try to read from the data.local JSON store
  const localStorePath = storeId
    ? `.runx/data/local-sources/${storeId}/${resource}/${aggregateId}.json`
    : `.runx/data/local-sources/${dataStoreRef.replace(/[^a-z0-9-]/gi, "_")}/${resource}/${aggregateId}.json`;

  try {
    if (fs.existsSync(localStorePath)) {
      const raw = fs.readFileSync(localStorePath, "utf8");
      const storeData = JSON.parse(raw);
      events = Array.isArray(storeData.events) ? storeData.events : [];
    }
  } catch {
    // No local store data; proceed with empty events
  }
}

// ─── FOLD ───────────────────────────────────────────────────────────────────
const memberMetrics = {};
for (const m of roster) {
  memberMetrics[m.member] = {
    member: m.member,
    skill: m.skill,
    turn_count: m.turn_count ?? 0,
    refusal_count: 0,
    completion_times: [],
  };
}

let schemaMismatch = false;
let version = 0;

for (const entry of events) {
  if (typeof entry.version === "number") version = entry.version;
  const event = entry.event ?? entry ?? {};
  if (event.schema_version && String(event.schema_version) !== declaredVersion) {
    schemaMismatch = true;
    break;
  }
  const payload = event.payload ?? {};
  if (event.type === "turn" || event.type === "dispatch") {
    const member = payload.member ?? payload.dispatch?.member ?? null;
    if (member && memberMetrics[member]) {
      if (payload.decision === "refuse" || payload.refused === true) {
        memberMetrics[member].refusal_count += 1;
      }
      if (typeof payload.completion_time === "number") {
        memberMetrics[member].completion_times.push(payload.completion_time);
      }
    }
  }
}

if (schemaMismatch) {
  process.stdout.write(JSON.stringify({
    stop: true,
    reason: "schema_version_mismatch",
    declared_version: declaredVersion,
    case_id: caseId,
  }, null, 2) + "\n");
  process.exit(0);
}

// Compute folded metrics
const folded = Object.values(memberMetrics).map((m) => {
  const avgCompletion = m.completion_times.length > 0
    ? m.completion_times.reduce((a, b) => a + b, 0) / m.completion_times.length
    : 0;
  const refusalRate = m.turn_count > 0
    ? m.refusal_count / m.turn_count
    : 0;
  return {
    member: m.member,
    skill: m.skill,
    turn_count: m.turn_count,
    refusal_count: m.refusal_count,
    refusal_rate: Math.round(refusalRate * 100) / 100,
    avg_completion_time: Math.round(avgCompletion * 100) / 100,
  };
});

// ─── GRADE ──────────────────────────────────────────────────────────────────
const agentAnswers = inputs.caller?.answers ?? inputs.agent_task_answers ?? null;

if (!agentAnswers) {
  // No caller answers: block with needs_agent before any decision
  process.stdout.write(JSON.stringify({
    stop: true,
    reason: "needs_agent",
    message: "Grading agent-task sub-step requires caller answers to produce a verdict.",
    folded_metrics: folded,
  }, null, 2) + "\n");
  process.exit(0);
}

const gradeAnswer = agentAnswers["agent_task.grade-member.output"] ?? agentAnswers["grade-member"] ?? null;

const graded = folded.map((m) => {
  const completionRatio = completionTimeThreshold > 0
    ? m.avg_completion_time / completionTimeThreshold
    : 0;
  const isUnderperformer = m.refusal_rate > refusalThreshold
    && m.avg_completion_time > completionTimeThreshold;

  return {
    member: m.member,
    skill: m.skill,
    refusal_count: m.refusal_count,
    refusal_rate: m.refusal_rate,
    avg_completion_time: m.avg_completion_time,
    completion_ratio: Math.round(completionRatio * 100) / 100,
    verdict: isUnderperformer ? "underperformer" : "acceptable",
    reason: isUnderperformer
      ? `${m.member} refusal rate ${m.refusal_rate} exceeds threshold ${refusalThreshold} and completion time ${m.avg_completion_time}s is ${Math.round(completionRatio * 10) / 10}x the ${completionTimeThreshold}s norm`
      : `${m.member} metrics within norms`,
  };
});

if (gradeAnswer) {
  const idx = graded.findIndex((g) => g.member === gradeAnswer.graded_member);
  if (idx >= 0) {
    graded[idx].refusal_count = gradeAnswer.refusal_count ?? graded[idx].refusal_count;
    graded[idx].refusal_rate = gradeAnswer.refusal_rate ?? graded[idx].refusal_rate;
    graded[idx].avg_completion_time = gradeAnswer.avg_completion_time ?? graded[idx].avg_completion_time;
    graded[idx].completion_ratio = gradeAnswer.completion_ratio ?? graded[idx].completion_ratio;
    graded[idx].verdict = gradeAnswer.verdict ?? graded[idx].verdict;
    graded[idx].reason = gradeAnswer.reason ?? graded[idx].reason;
  }
}

// ─── DECIDE ─────────────────────────────────────────────────────────────────
const underperformers = graded.filter((m) => m.verdict === "underperformer");

let decision;
let guardRails = {
  min_roster_size: minRosterSize,
  remaining_after_removal: roster.length,
  sole_skill_block: false,
};

if (underperformers.length === 0) {
  decision = {
    underperformer: false,
    member_to_remove: null,
    replacement_candidate: null,
    reason: "No members exceed the refusal and completion time thresholds.",
  };
} else {
  underperformers.sort((a, b) => (b.refusal_rate + b.completion_ratio) - (a.refusal_rate + a.completion_ratio));
  const worst = underperformers[0];
  const remainingAfterRemoval = roster.length - 1;

  if (remainingAfterRemoval < minRosterSize) {
    decision = {
      underperformer: true,
      member_to_remove: null,
      replacement_candidate: null,
      reason: `${worst.member} underperforms (${worst.reason}) but removal would reduce roster below min_roster_size ${minRosterSize}.`,
    };
    guardRails.triggered = "min_roster_guard";
    guardRails.remaining_after_removal = remainingAfterRemoval;
  } else {
    const skillHolders = roster.filter((r) => r.skill === worst.skill);
    if (skillHolders.length === 1 && skillHolders[0].member === worst.member) {
      decision = {
        underperformer: true,
        member_to_remove: null,
        replacement_candidate: null,
        reason: `${worst.member} underperforms (${worst.reason}) but is the sole holder of skill ${worst.skill}.`,
      };
      guardRails.sole_skill_block = true;
      guardRails.triggered = "sole_skill_guard";
      guardRails.remaining_after_removal = remainingAfterRemoval;
    } else {
      const sameSkillCandidates = roster.filter(
        (r) => r.skill === worst.skill && r.member !== worst.member
      );
      const replacement = sameSkillCandidates.length > 0
        ? sameSkillCandidates[0].member
        : `replacement-needed:${worst.skill}`;

      decision = {
        underperformer: true,
        member_to_remove: worst.member,
        replacement_candidate: replacement,
        reason: worst.reason,
      };
      guardRails.remaining_after_removal = remainingAfterRemoval;
    }
  }
}

// ─── APPEND JUDGMENT TO DATA STORE ──────────────────────────────────────────
const judgmentEvent = {
  type: "roster_tuned",
  payload: {
    decision,
    graded_members: graded,
  },
};

// Write to local data store if using data.local
if (storeId) {
  const storePath = `.runx/data/local-sources/${storeId}/${resource}/${aggregateId}.json`;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    let storeData = { events: [] };
    try {
      storeData = JSON.parse(fs.readFileSync(storePath, "utf8"));
    } catch { /* new store */ }
    const newVersion = version + 1;
    storeData.events.push({
      version: newVersion,
      event: judgmentEvent,
    });
    fs.writeFileSync(storePath, JSON.stringify(storeData, null, 2));
  } catch {
    // Best effort write; don't fail the skill
  }
}

// ─── OUTPUT ─────────────────────────────────────────────────────────────────
process.stdout.write(JSON.stringify({
  roster_decision: {
    schema: "runx.roster.tuning.v1",
    case_id: caseId,
    decision,
    projection: {
      aggregate_id: aggregateId,
      version_before: version,
      events_folded: events.length,
    },
    appended_judgment: {
      aggregate_id: aggregateId,
      version_after: version + 1,
      idempotency_key: idempotencyKey,
      event_ref: `${resource}:${aggregateId}:${version + 1}`,
    },
    judgment_event: judgmentEvent,
    folded_metrics: graded,
    guard_rails: guardRails,
  },
}, null, 2) + "\n");
