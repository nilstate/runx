import fs from "node:fs";

// Decide on underperformers from graded metrics.
// Enforces guard rails: min_roster_size, sole_skill protection.
// Produces a judgment event for appending to the case stream.

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

const inputs = readInputs();
const gradeResult = inputs.grade ?? {};
const foldedMetrics = inputs.folded_metrics ?? {};
const gradeAnswer = inputs.grade_answer ?? null;
const events = Array.isArray(inputs.events) ? inputs.events : [];
const roster = Array.isArray(inputs.roster) ? inputs.roster : [];
const norms = inputs.performance_norms ?? {};
const minRosterSize = norms.min_roster_size ?? 2;
const refusalThreshold = norms.refusal_threshold ?? 0.6;
const completionTimeThreshold = norms.completion_time_threshold ?? 120;
const caseId = inputs.case_id ?? null;
const resource = inputs.resource ?? "agency_cases";
const aggregateId = inputs.aggregate_id ?? caseId;
const idempotencyKey = inputs.idempotency_key ?? "";

let gradedMembers = Array.isArray(gradeResult.graded_members)
  ? gradeResult.graded_members
  : [];

if (gradedMembers.length === 0) {
  const members = Array.isArray(foldedMetrics.members) ? foldedMetrics.members : [];
  gradedMembers = members.map((m) => {
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
}

if (gradeAnswer?.graded_member) {
  let idx = gradedMembers.findIndex((g) => g.member === gradeAnswer.graded_member);
  if (idx < 0) {
    const rosterMember = roster.find((r) => r.member === gradeAnswer.graded_member) ?? {};
    gradedMembers.push({
      member: gradeAnswer.graded_member,
      skill: rosterMember.skill ?? "unknown",
      refusal_count: 0,
      refusal_rate: 0,
      avg_completion_time: 0,
      completion_ratio: 0,
      verdict: "acceptable",
      reason: `${gradeAnswer.graded_member} metrics within norms`,
    });
    idx = gradedMembers.length - 1;
  }
  gradedMembers[idx] = {
    ...gradedMembers[idx],
    refusal_count: gradeAnswer.refusal_count ?? gradedMembers[idx].refusal_count,
    refusal_rate: gradeAnswer.refusal_rate ?? gradedMembers[idx].refusal_rate,
    avg_completion_time: gradeAnswer.avg_completion_time ?? gradedMembers[idx].avg_completion_time,
    completion_ratio: gradeAnswer.completion_ratio ?? gradedMembers[idx].completion_ratio,
    verdict: gradeAnswer.verdict ?? gradedMembers[idx].verdict,
    reason: gradeAnswer.reason ?? gradedMembers[idx].reason,
  };
}

// Compute version from events
let version = 0;
for (const entry of events) {
  if (typeof entry.version === "number") version = entry.version;
}

// Find underperformers
const underperformers = gradedMembers.filter((m) => m.verdict === "underperformer");

if (underperformers.length === 0) {
  // No underperformers found
  const judgmentEvent = {
    type: "roster_tuned",
    payload: {
      decision: {
        underperformer: false,
        member_to_remove: null,
        replacement_candidate: null,
        reason: "No members exceed the refusal and completion time thresholds.",
      },
      graded_members: gradedMembers,
    },
  };

  process.stdout.write(JSON.stringify({
    roster_decision: {
      schema: "runx.roster.tuning.v1",
      case_id: caseId,
      decision: judgmentEvent.payload.decision,
      projection: {
        aggregate_id: aggregateId,
        events_folded: events.length,
        version_before: version,
      },
      appended_judgment: {
        aggregate_id: aggregateId,
        version_after: version + 1,
        idempotency_key: idempotencyKey,
        event_ref: `${resource}:${aggregateId}:${version + 1}`,
      },
      judgment_event: judgmentEvent,
      folded_metrics: gradedMembers,
      guard_rails: {
        min_roster_size: minRosterSize,
        remaining_after_removal: roster.length,
        sole_skill_block: false,
      },
    },
  }, null, 2) + "\n");
  process.exit(0);
}

// Sort underperformers by severity (worst first)
underperformers.sort((a, b) => (b.refusal_rate + b.completion_ratio) - (a.refusal_rate + a.completion_ratio));
const worst = underperformers[0];

// Guard rail: min roster size
const remainingAfterRemoval = roster.length - 1;
if (remainingAfterRemoval < minRosterSize) {
  const judgmentEvent = {
    type: "roster_tuned",
    payload: {
      decision: {
        underperformer: true,
        member_to_remove: null,
        replacement_candidate: null,
        reason: `${worst.member} underperforms (${worst.reason}) but removal would reduce roster below min_roster_size ${minRosterSize}.`,
      },
      guard_rail_triggered: "min_roster_guard",
    },
  };

  process.stdout.write(JSON.stringify({
    roster_decision: {
      schema: "runx.roster.tuning.v1",
      case_id: caseId,
      decision: judgmentEvent.payload.decision,
      projection: {
        aggregate_id: aggregateId,
        events_folded: events.length,
        version_before: version,
      },
      appended_judgment: {
        aggregate_id: aggregateId,
        version_after: version + 1,
        idempotency_key: idempotencyKey,
        event_ref: `${resource}:${aggregateId}:${version + 1}`,
      },
      guard_rails: {
        min_roster_size: minRosterSize,
        remaining_after_removal: remainingAfterRemoval,
        sole_skill_block: false,
        triggered: "min_roster_guard",
      },
      judgment_event: judgmentEvent,
      folded_metrics: gradedMembers,
    },
  }, null, 2) + "\n");
  process.exit(0);
}

// Guard rail: sole skill protection
const skillHolders = roster.filter((r) => r.skill === worst.skill);
if (skillHolders.length === 1 && skillHolders[0].member === worst.member) {
  const judgmentEvent = {
    type: "roster_tuned",
    payload: {
      decision: {
        underperformer: true,
        member_to_remove: null,
        replacement_candidate: null,
        reason: `${worst.member} underperforms (${worst.reason}) but is the sole holder of skill ${worst.skill}.`,
      },
      guard_rail_triggered: "sole_skill_guard",
    },
  };

  process.stdout.write(JSON.stringify({
    roster_decision: {
      schema: "runx.roster.tuning.v1",
      case_id: caseId,
      decision: judgmentEvent.payload.decision,
      projection: {
        aggregate_id: aggregateId,
        events_folded: events.length,
        version_before: version,
      },
      appended_judgment: {
        aggregate_id: aggregateId,
        version_after: version + 1,
        idempotency_key: idempotencyKey,
        event_ref: `${resource}:${aggregateId}:${version + 1}`,
      },
      guard_rails: {
        min_roster_size: minRosterSize,
        remaining_after_removal: remainingAfterRemoval,
        sole_skill_block: true,
        triggered: "sole_skill_guard",
      },
      judgment_event: judgmentEvent,
      folded_metrics: gradedMembers,
    },
  }, null, 2) + "\n");
  process.exit(0);
}

// Find replacement candidate: same skill, not the underperformer
const sameSkillCandidates = roster.filter(
  (r) => r.skill === worst.skill && r.member !== worst.member
);
const replacement = sameSkillCandidates.length > 0
  ? sameSkillCandidates[0].member
  : `replacement-needed:${worst.skill}`;

const judgmentEvent = {
  type: "roster_tuned",
  payload: {
    decision: {
      underperformer: true,
      member_to_remove: worst.member,
      replacement_candidate: replacement,
      reason: worst.reason,
    },
    graded_members: gradedMembers,
  },
};

process.stdout.write(JSON.stringify({
    roster_decision: {
      schema: "runx.roster.tuning.v1",
      case_id: inputs.case_id ?? null,
      decision: judgmentEvent.payload.decision,
      projection: {
        aggregate_id: aggregateId,
        events_folded: events.length,
        version_before: version,
      },
      appended_judgment: {
        aggregate_id: aggregateId,
        version_after: version + 1,
        idempotency_key: idempotencyKey,
        event_ref: `${resource}:${aggregateId}:${version + 1}`,
      },
      judgment_event: judgmentEvent,
      folded_metrics: gradedMembers,
    guard_rails: {
      min_roster_size: minRosterSize,
      remaining_after_removal: remainingAfterRemoval,
      sole_skill_block: false,
    },
  },
}, null, 2) + "\n");
