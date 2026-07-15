import fs from "node:fs";

const inputs = readInputs();
const siteRef = requiredString(inputs.site_ref, "site_ref");
const pages = requiredArray(inputs.site_inventory?.pages, "site_inventory.pages").map(normalizePage);
const terms = requiredArray(inputs.demand_fixtures?.terms, "demand_fixtures.terms");
const excludedTopics = stringArray(inputs.content_policy?.excluded_topics, "content_policy.excluded_topics");
const priorityThemes = stringArray(inputs.content_policy?.priority_themes, "content_policy.priority_themes");

const droppedByPolicy = [];
const usableTerms = [];
const unusableTerms = [];

for (const rawTerm of terms) {
  const term = optionalString(rawTerm?.term);
  const demandSignal = optionalString(rawTerm?.demand_signal);
  const source = optionalString(rawTerm?.source);
  if (!term || !demandSignal || !source) {
    unusableTerms.push({ term: term || null, missing: missingDemandFields({ term, demandSignal, source }) });
    continue;
  }

  const exclusion = excludedTopics.find((topic) => containsPhrase(term, topic));
  if (exclusion) {
    droppedByPolicy.push({ term, exclusion, source });
    continue;
  }

  usableTerms.push({
    term,
    demand_signal: demandSignal,
    source,
    numeric_signal: numericSignal(demandSignal),
  });
}

const evaluations = usableTerms.map((term) => evaluateTerm(term, pages));
const candidateGaps = evaluations.filter((entry) => entry.status !== "covered");
const incomparable = candidateGaps.length > 1 && candidateGaps.some((entry) => entry.term.numeric_signal === null);

let decision;
let gapFindings;
let coveredTerms;
let stopReason;

if (usableTerms.length === 0) {
  decision = "needs_more_evidence";
  gapFindings = [];
  coveredTerms = [];
  stopReason = "No supplied demand term has a non-empty term, named demand signal, and public source.";
} else if (incomparable) {
  decision = "needs_more_evidence";
  gapFindings = [];
  coveredTerms = evaluations.filter((entry) => entry.status === "covered").map(coveredTerm);
  stopReason = "Multiple candidate gaps lack comparable numeric demand evidence, so a defensible priority order cannot be produced.";
} else {
  decision = "ready";
  const ordered = [...candidateGaps].sort(compareGaps);
  gapFindings = ordered.map((entry, index) => gapFinding(entry, index, ordered.length, priorityThemes));
  coveredTerms = evaluations.filter((entry) => entry.status === "covered").map(coveredTerm);
  stopReason = null;
}

const reviewReason = decision === "ready"
  ? `Reviewed ${usableTerms.length} grounded demand term(s) for ${siteRef}; emitted ${gapFindings.length} gap(s), recorded ${coveredTerms.length} covered term(s), and dropped ${droppedByPolicy.length} policy-excluded term(s).`
  : `Stopped the review for ${siteRef}: ${stopReason}`;

const result = {
  decision,
  gap_findings: gapFindings,
  covered_terms: coveredTerms,
  dropped_by_policy: droppedByPolicy,
  stop_reason: stopReason,
  review_reason: reviewReason,
  evidence_summary: {
    site_ref: siteRef,
    page_count: pages.length,
    demand_term_count: terms.length,
    usable_term_count: usableTerms.length,
    unusable_terms: unusableTerms,
    source_refs: usableTerms.map((entry) => entry.source),
    observations: [
      `${pages.length} supplied public page record(s) were reviewed without fetching or crawling.`,
      `${usableTerms.length} demand term(s) had a named signal and source.`,
      `${droppedByPolicy.length} term(s) were removed by the exact supplied exclusion phrase.`,
      decision === "ready"
        ? `${gapFindings.length} grounded gap(s) were ranked; every gap names runx/draft-content as the downstream lane.`
        : stopReason,
    ],
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizePage(page, index) {
  return {
    url: requiredString(page?.url, `site_inventory.pages[${index}].url`),
    topic: requiredString(page?.topic, `site_inventory.pages[${index}].topic`),
    coverage: requiredString(page?.coverage, `site_inventory.pages[${index}].coverage`),
  };
}

function evaluateTerm(term, pages) {
  const termTokens = [...tokens(term.term)];
  const scoredPages = pages.map((page) => {
    const topicTokens = tokens(`${page.topic} ${page.coverage}`);
    const overlap = termTokens.filter((token) => topicTokens.has(token));
    return { page, overlap, overlap_ratio: termTokens.length === 0 ? 0 : overlap.length / termTokens.length };
  }).sort((a, b) => b.overlap_ratio - a.overlap_ratio || b.overlap.length - a.overlap.length || a.page.url.localeCompare(b.page.url));

  const best = scoredPages[0];
  if (!best || best.overlap.length === 0) {
    return { term, status: "missing", page: null, reason: "No supplied page topic or coverage shares a meaningful term with the grounded query." };
  }

  const limitation = coverageLimitation(best.page.coverage);
  if (best.overlap_ratio < 1 || limitation) {
    const reason = limitation
      ? `The closest supplied page is limited: ${best.page.coverage}`
      : `The closest supplied page covers only ${best.overlap.length} of ${termTokens.length} meaningful query terms: ${best.page.coverage}`;
    return { term, status: "weak", page: best.page, reason };
  }

  return { term, status: "covered", page: best.page, reason: `The supplied topic and coverage directly address every meaningful query term: ${best.page.coverage}` };
}

function gapFinding(entry, index, count, priorityThemes) {
  const level = index === 0 ? "high" : index === count - 1 && count > 2 ? "low" : "medium";
  const theme = priorityThemes.find((candidate) => containsPhrase(entry.term.term, candidate));
  return {
    term: entry.term.term,
    demand_grounding: {
      signal: entry.term.demand_signal,
      source: entry.term.source,
    },
    page_verdict: {
      status: entry.status,
      page_url: entry.page?.url || null,
      reason: entry.reason,
    },
    priority: {
      level,
      reason: `${entry.term.demand_signal}${theme ? ` The query matches the supplied priority theme "${theme}".` : ""} The ${entry.status} page verdict is grounded only in the supplied inventory.`,
    },
    dispatch_target: "runx/draft-content",
  };
}

function coveredTerm(entry) {
  return {
    term: entry.term.term,
    demand_grounding: { signal: entry.term.demand_signal, source: entry.term.source },
    page_url: entry.page.url,
    reason: entry.reason,
  };
}

function compareGaps(a, b) {
  const scoreA = a.term.numeric_signal ?? -1;
  const scoreB = b.term.numeric_signal ?? -1;
  return scoreB - scoreA || a.term.term.localeCompare(b.term.term);
}

function numericSignal(value) {
  const match = value.replaceAll(",", "").match(/(?:^|\D)(\d+(?:\.\d+)?)(?:\s*([kKmM]))?/);
  if (!match) return null;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  return Number(match[1]) * multiplier;
}

function coverageLimitation(value) {
  return /\b(lacks?|without|does not|doesn't|missing|brief|single|only|overview)\b/i.test(value);
}

function tokens(value) {
  const stop = new Set(["a", "an", "and", "for", "how", "in", "of", "on", "the", "to", "with"]);
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !stop.has(token)) || []);
}

function containsPhrase(value, phrase) {
  return value.toLowerCase().includes(phrase.toLowerCase());
}

function missingDemandFields({ term, demandSignal, source }) {
  return [!term && "term", !demandSignal && "demand_signal", !source && "source"].filter(Boolean);
}

function requiredArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  return value;
}

function stringArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function requiredString(value, field) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
