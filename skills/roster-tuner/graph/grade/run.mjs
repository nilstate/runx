import fs from "node:fs";

// Grade folded member metrics against operator-supplied norms.
// This is the agent-task step: when caller.answers is supplied, the
// harness uses the pre-graded verdict; when omitted, the runtime blocks
// with needs_agent before any decision is appended.

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

const inputs = readInputs();
const foldedMetrics = inputs.folded_metrics ?? {};
const members = Array.isArray(foldedMetrics.members) ? foldedMetrics.members : [];
const norms = inputs.performance_norms ?? {};

const refusalThreshold = norms.refusal_threshold ?? 0.6;
const completionTimeThreshold = norms.completion_time_threshold ?? 120;

// Check for agent-task answers (caller.answers)
const agentAnswers = inputs.agent_task_answers ?? inputs.caller_answers ?? null;

if (!agentAnswers) {
  // No caller answers: block with needs_agent
  process.stdout.write(JSON.stringify({
    stop: true,
    reason: "needs_agent",
    message: "Grading agent-task sub-step requires caller answers to produce a verdict.",
  }, null, 2) + "\n");
  process.exit(0);
}

// Use the agent-task answer for grading
const gradeAnswer = agentAnswers["agent_task.grade-member.output"] ?? agentAnswers["grade-member"] ?? null;

if (!gradeAnswer) {
  process.stdout.write(JSON.stringify({
    stop: true,
    reason: "needs_agent",
    message: "No grade-member answer provided in caller answers.",
  }, null, 2) + "\n");
  process.exit(0);
}

// Build graded members from the answer and folded metrics
const graded = members.map((m) => {
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

// Override with agent answer if it names a specific member
if (gradeAnswer.graded_member) {
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

process.stdout.write(JSON.stringify({
  grade_result: {
    schema: "runx.roster.grade.v1",
    graded_members: graded,
    norms_applied: {
      refusal_threshold: refusalThreshold,
      completion_time_threshold: completionTimeThreshold,
    },
  },
}, null, 2) + "\n");
