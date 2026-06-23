import fs from "node:fs";

const inputs = readInputs();
const resumes = array(inputs.resumes, "resumes");
const jd = object(inputs.jd, "jd");
const rubric = object(inputs.rubric, "rubric");
const criteria = array(rubric.criteria, "rubric.criteria").map(normalizeCriterion);

if (["hire", "reject", "advance"].includes(text(rubric.requested_action)?.toLowerCase())) {
  fail("final hiring, rejection, and advancement decisions require a human");
}

const protectedKeys = [
  "age", "race", "ethnicity", "sex", "gender", "gender_identity", "religion",
  "disability", "pregnancy", "marital_status", "citizenship", "national_origin",
  "photo", "name",
];
const redFlags = [];
const scored = resumes.map((resume, index) => scoreResume(resume, index));
const ranked = [...scored].sort((a, b) => b.total_score - a.total_score
  || a.candidate_id.localeCompare(b.candidate_id))
  .map((candidate, rank) => ({
    rank: rank + 1,
    candidate_id: candidate.candidate_id,
    total_score: candidate.total_score,
  }));
const shortlistSize = Math.max(0, Math.min(ranked.length, integer(rubric.shortlist_size, 3)));
const shortlisted = ranked.slice(0, shortlistSize).map((item) => item.candidate_id);
const interviewQs = scored.flatMap((candidate) => candidate.criteria
  .filter((criterion) => criterion.evidence.length === 0 || criterion.score < criterion.max_score)
  .map((criterion) => ({
    candidate_id: candidate.candidate_id,
    criterion_id: criterion.criterion_id,
    question: `Please provide a specific example demonstrating ${criterion.criterion_id} and describe your individual contribution.`,
    reason: criterion.evidence.length === 0 ? "missing_resume_evidence" : "validate_partial_evidence",
  })));

emit({
  scored,
  ranked,
  red_flags: redFlags,
  interview_qs: interviewQs,
  shortlist_proposal: {
    role: text(jd.title) || "unlabelled role",
    candidate_ids: shortlisted,
    status: "proposed",
    human_approval_required: true,
    final_decision_made: false,
    effects_emitted: [],
    basis: "supplied_job_related_rubric_only",
  },
});

function scoreResume(value, index) {
  const resume = object(value, `resumes[${index}]`);
  const candidateId = text(resume.id) || `candidate-${index + 1}`;

  for (const key of protectedKeys) {
    if (resume[key] !== undefined) {
      redFlags.push({
        candidate_id: candidateId,
        type: "bias_risk",
        field: key,
        action: "ignored_not_scored",
      });
    }
  }

  const evidence = Array.isArray(resume.evidence) ? resume.evidence.filter(isObject) : [];
  const criterionScores = criteria.map((criterion) => {
    const matches = evidence.filter((item) => slug(text(item.skill) || "") === criterion.id);
    const years = matches.reduce((maximum, item) => Math.max(maximum, number(item.years)), 0);
    const ratio = criterion.min_years > 0 ? Math.min(1, years / criterion.min_years) : matches.length ? 1 : 0;
    const score = round(criterion.weight * ratio);
    if (matches.length === 0) {
      redFlags.push({
        candidate_id: candidateId,
        type: "evidence_gap",
        criterion_id: criterion.id,
        action: "ask_in_interview",
      });
    }
    return {
      criterion_id: criterion.id,
      score,
      max_score: criterion.weight,
      observed_years: years,
      required_years: criterion.min_years,
      evidence: matches.map((item) => text(item.source)).filter(Boolean),
    };
  });

  return {
    candidate_id: candidateId,
    total_score: round(criterionScores.reduce((sum, item) => sum + item.score, 0)),
    criteria: criterionScores,
    protected_attributes_used: [],
  };
}

function normalizeCriterion(value, index) {
  const criterion = object(value, `rubric.criteria[${index}]`);
  const id = slug(text(criterion.id) || "");
  const weight = number(criterion.weight);
  if (!id || weight <= 0) fail("each rubric criterion requires id and positive weight");
  return { id, weight, min_years: Math.max(0, number(criterion.min_years)) };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function object(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function array(value, name) {
  if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty array`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

