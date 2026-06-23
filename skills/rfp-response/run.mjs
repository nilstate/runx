import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const questionnaire = requireArray(inputs.questionnaire, "questionnaire");
const knowledgePack = requireObject(inputs.knowledge_pack, "knowledge_pack");
const objective = stringValue(inputs.objective) || "Draft grounded RFP responses.";

const sources = normalizeSources(knowledgePack);
const answers = [];
const gaps = [];

for (const rawQuestion of questionnaire) {
  const item = normalizeQuestion(rawQuestion);
  const matches = rankClaims(item, sources);
  if (matches.length === 0) {
    gaps.push({
      q: item.id,
      question: item.question,
      section: item.section,
      reason: "No supplied knowledge-pack claim supports this answer.",
      needed_evidence: "Add a source claim that directly addresses the requested fact before answering.",
    });
    continue;
  }

  const top = matches.slice(0, 3);
  answers.push({
    q: item.id,
    question: item.question,
    section: item.section,
    answer: top.map((match) => match.claim.text).join(" "),
    citations: top.map((match) => ({
      source_id: match.source.id,
      claim_id: match.claim.id,
      title: match.source.title,
      url: match.source.url || null,
    })),
    confidence: confidenceFromScore(top[0].score),
  });
}

const evidenceJson = {
  schema: "frantic.delivery.evidence.v1",
  artifact: "rfp-response",
  objective,
  knowledge_digest: sha256Json(knowledgePack),
  questionnaire_digest: sha256Json(questionnaire),
  observations: {
    answered_count: answers.length,
    gap_count: gaps.length,
    sample_citations: answers.flatMap((answer) => answer.citations).slice(0, 5),
    refused_questions: gaps.map((gap) => gap.q),
    read_only: true,
    network_used: false,
    effect_emitted: false,
  },
};

const report = renderReport(answers, gaps, sources);

process.stdout.write(`${JSON.stringify({ answers, gaps, evidence_json: evidenceJson, report }, null, 2)}\n`);

function normalizeQuestion(value) {
  if (!isObject(value)) throw new Error("questionnaire entries must be objects");
  const id = stringValue(value.id) || `q${answers.length + gaps.length + 1}`;
  const question = stringValue(value.question);
  if (!question) throw new Error(`questionnaire.${id}.question is required`);
  return {
    id,
    question,
    section: stringValue(value.section) || "general",
    tokens: tokenize(question),
  };
}

function normalizeSources(pack) {
  const rawSources = requireArray(pack.sources, "knowledge_pack.sources");
  const normalized = rawSources.map((source, sourceIndex) => {
    if (!isObject(source)) throw new Error(`knowledge_pack.sources[${sourceIndex}] must be an object`);
    const id = stringValue(source.id) || `source-${sourceIndex + 1}`;
    const claims = requireArray(source.claims, `knowledge_pack.sources.${id}.claims`).map((claim, claimIndex) => {
      if (!isObject(claim)) throw new Error(`claim ${claimIndex + 1} in ${id} must be an object`);
      const text = stringValue(claim.text);
      if (!text) throw new Error(`claim ${claimIndex + 1} in ${id} requires text`);
      const tags = arrayValue(claim.tags).map(String);
      return {
        id: stringValue(claim.id) || `${id}-claim-${claimIndex + 1}`,
        text,
        tags,
        tokens: new Set([...tokenize(text), ...tags.flatMap(tokenize)]),
      };
    });
    return {
      id,
      title: stringValue(source.title) || id,
      url: stringValue(source.url),
      claims,
    };
  });
  if (normalized.length === 0) throw new Error("knowledge_pack.sources must not be empty");
  return normalized;
}

function rankClaims(question, normalizedSources) {
  const results = [];
  for (const source of normalizedSources) {
    for (const claim of source.claims) {
      const overlap = question.tokens.filter((token) => claim.tokens.has(token));
      const exactSectionBoost = claim.tokens.has(question.section.toLowerCase()) ? 2 : 0;
      const score = overlap.length + exactSectionBoost;
      if (score >= 2) results.push({ source, claim, score });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id));
}

function confidenceFromScore(score) {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function renderReport(answerRows, gapRows, normalizedSources) {
  const lines = [
    "# rfp-response report",
    "",
    `Answered questions: ${answerRows.length}`,
    `Gaps: ${gapRows.length}`,
    `Knowledge sources: ${normalizedSources.length}`,
    "",
    "## Answers",
    ...answerRows.map((answer) => `- ${answer.q}: ${answer.answer} Citations: ${answer.citations.map((c) => `${c.source_id}/${c.claim_id}`).join(", ")}`),
    "",
    "## Gaps",
    ...(gapRows.length ? gapRows.map((gap) => `- ${gap.q}: ${gap.reason}`) : ["- none"]),
    "",
    "The draft is read-only and requires human approval before external use.",
  ];
  return lines.join("\n");
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) return JSON.parse(raw);
  }
  return {};
}

function requireObject(value, field) {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tokenize(text) {
  const stop = new Set(["a", "an", "and", "are", "at", "by", "do", "does", "for", "how", "in", "is", "of", "or", "the", "to", "with", "you", "your"]);
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stop.has(token));
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  return value;
}
