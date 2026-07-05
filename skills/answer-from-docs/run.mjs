import fs from "node:fs";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "contain",
  "contains",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "must",
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

const inputs = readInputs();
const question = stringValue(inputs.question);
const corpus = normalizeCorpus(inputs.corpus);

if (!question) {
  throw new Error("question must be a non-empty string");
}

const questionTerms = tokenize(question);
const candidates = corpus.flatMap((item) => splitSentences(item.text).map((sentence) => ({ ...item, sentence })));
const ranked = candidates
  .map((candidate) => ({ ...candidate, score: scoreCandidate(questionTerms, candidate.sentence) }))
  .filter((candidate) => candidate.score.matches > 0)
  .sort((left, right) => {
    if (right.score.coverage !== left.score.coverage) return right.score.coverage - left.score.coverage;
    if (right.score.matches !== left.score.matches) return right.score.matches - left.score.matches;
    return left.sentence.length - right.sentence.length;
  });

const best = ranked[0];
const grounded = Boolean(best && best.score.coverage >= 0.35 && best.score.matches >= Math.min(2, questionTerms.length));

const result = grounded
  ? groundedAnswer(question, best)
  : refusedAnswer(question, corpus, questionTerms, best);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizeCorpus(value) {
  if (!Array.isArray(value)) {
    throw new Error("corpus must be an array");
  }
  return value
    .map((entry, index) => normalizeCorpusItem(entry, index))
    .filter((entry) => entry.text.length > 0);
}

function normalizeCorpusItem(entry, index) {
  if (typeof entry === "string") {
    return {
      id: `corpus-${index + 1}`,
      title: null,
      text: entry.trim(),
    };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      id: `corpus-${index + 1}`,
      title: null,
      text: "",
    };
  }
  const id = stringValue(entry.id) || stringValue(entry.source_id) || `corpus-${index + 1}`;
  const title = stringValue(entry.title) || stringValue(entry.name);
  const text = [
    stringValue(entry.text),
    stringValue(entry.content),
    stringValue(entry.body),
    stringValue(entry.markdown),
  ].find(Boolean) || "";
  return { id, title, text };
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function tokenize(text) {
  const terms = text
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  const meaningful = terms.map(normalizeTerm).filter((term) => term.length > 2 && !STOP_WORDS.has(term));
  return [...new Set(meaningful)];
}

function normalizeTerm(term) {
  if (term.length > 4 && term.endsWith("ies")) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.length > 4 && term.endsWith("s")) {
    return term.slice(0, -1);
  }
  return term;
}

function scoreCandidate(questionTerms, sentence) {
  const sentenceTerms = new Set(tokenize(sentence));
  const matches = questionTerms.filter((term) => sentenceTerms.has(term));
  return {
    matches: matches.length,
    coverage: questionTerms.length === 0 ? 0 : matches.length / questionTerms.length,
    matched_terms: matches,
  };
}

function groundedAnswer(question, candidate) {
  const answerText = candidate.sentence;
  return {
    answer: {
      text: answerText,
      citations: [
        {
          sentence: answerText,
          source_id: candidate.id,
          source_title: candidate.title,
          evidence: candidate.sentence,
        },
      ],
    },
    kb_gaps: [],
    grounded: true,
    observations: {
      question,
      grounding: "selected sentence met overlap threshold against supplied corpus",
      citation_mapping: [
        {
          answer_sentence: answerText,
          source_id: candidate.id,
          matched_terms: candidate.score.matched_terms,
        },
      ],
    },
  };
}

function refusedAnswer(question, corpus, questionTerms, best) {
  const readableSources = corpus.map((entry) => entry.id);
  return {
    answer: {
      text: "",
      citations: [],
    },
    kb_gaps: [
      `No supplied corpus item sufficiently supports answering: ${question}`,
      `Needed evidence terms not grounded in corpus: ${questionTerms.join(", ") || "question terms"}`,
    ],
    grounded: false,
    observations: {
      question,
      grounding: "refused because supplied corpus did not meet overlap threshold",
      readable_sources: readableSources,
      best_candidate: best
        ? {
            source_id: best.id,
            coverage: best.score.coverage,
            matched_terms: best.score.matched_terms,
          }
        : null,
    },
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
