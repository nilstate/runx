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
const gradedMembers = Array.isArray(gradeResult.graded_members) ? gradeResult.graded_members : [];
const events = Array.isArray(inputs.events) ? inputs.events : [];
const roster = Array.isArray(inputs.roster) ? inputs.roster : [];
const norms = inputs.performance_norms ?? {};
const minRosterSize = norms.min_roster_size ?? 2;

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
      decision: judgmentEvent.payload.decision,
      projection: {
        events_folded: events.length,
        version_before: version,
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
      decision: judgmentEvent.payload.decision,
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
      decision: judgmentEvent.payload.decision,
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
    decision: judgmentEvent.payload.decision,
    projection: {
      events_folded: events.length,
      version_before: version,
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
