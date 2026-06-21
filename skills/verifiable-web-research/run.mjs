import fs from "node:fs";
import crypto from "node:crypto";

const input = readInputs();
const question = text(input.research_question);
const sources = Array.isArray(input.source_snapshots) ? input.source_snapshots.map(normalizeSource).filter(Boolean) : [];
const policy = obj(input.research_policy);
const minSources = Number.isFinite(policy.min_sources) ? Math.max(1, Number(policy.min_sources)) : 1;

if (!question || sources.length < minSources) {
  emit({
    status: "needs_more_evidence",
    answer: "",
    claims: [],
    source_table: sources,
    citation_map: {},
    verification_gaps: [
      !question ? "research_question is required" : null,
      sources.length < minSources ? `Need at least ${minSources} public source snapshot(s); got ${sources.length}.` : null,
    ].filter(Boolean),
    evidence: { source_count: sources.length, min_sources: minSources, side_effects: "none" },
  });
}

const claims = buildClaims(question, sources);
const citationMap = Object.fromEntries(claims.map((claim) => [claim.id, claim.source_ids]));
emit({
  status: "ready",
  answer: renderAnswer(question, claims),
  claims,
  source_table: sources,
  citation_map: citationMap,
  verification_gaps: gapsFor(sources),
  evidence: {
    question_hash: sha256(question),
    source_count: sources.length,
    every_claim_has_citation: claims.every((claim) => claim.source_ids.length > 0),
    target_code_executed: false,
    network_performed_by_skill: false,
    side_effects: "none",
  },
});

function buildClaims(question, sources) {
  return sources.slice(0, 5).map((source, index) => ({
    id: `claim_${index + 1}`,
    text: summarize(source.excerpt || source.quote || source.title),
    source_ids: [source.id],
    confidence: source.url && source.excerpt ? "high_from_supplied_snapshot" : "medium_from_partial_snapshot",
    relevance: relevance(question, source),
  }));
}

function renderAnswer(question, claims) {
  return [
    `Question: ${question}`,
    "",
    "Answer:",
    ...claims.map((claim) => `- ${claim.text} [${claim.source_ids.join(", ")}]`),
  ].join("\n");
}

function normalizeSource(source, index) {
  if (!source || typeof source !== "object") return null;
  const id = text(source.id) || `src_${index + 1}`;
  const url = text(source.url);
  const title = text(source.title) || url || id;
  const excerpt = text(source.excerpt) || text(source.quote) || "";
  if (!url && !excerpt) return null;
  return {
    id,
    url,
    title,
    excerpt: excerpt.replace(/\s+/g, " ").slice(0, 500),
    observed_at: text(source.observed_at) || null,
    snapshot_hash: sha256(`${url || ""}\n${title}\n${excerpt}`),
  };
}

function gapsFor(sources) {
  const gaps = [];
  for (const source of sources) {
    if (!source.url) gaps.push(`${source.id} has no URL.`);
    if (!source.observed_at) gaps.push(`${source.id} has no observed_at timestamp.`);
    if (!source.excerpt) gaps.push(`${source.id} has no excerpt or quote.`);
  }
  return gaps;
}

function relevance(question, source) {
  const q = new Set(String(question).toLowerCase().split(/\W+/).filter(Boolean));
  const words = String(`${source.title} ${source.excerpt}`).toLowerCase().split(/\W+/).filter(Boolean);
  return words.filter((word) => q.has(word)).length;
}

function readInputs() { if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")); if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON); return {}; }
function obj(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function summarize(value) { const clean = String(value || "").replace(/\s+/g, " ").trim(); return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean; }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }

