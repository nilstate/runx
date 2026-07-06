import fs from "node:fs";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "can",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "or",
  "the",
  "them",
  "they",
  "to",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
]);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  const parsed = JSON.parse(raw);
  return {
    question: typeof parsed.question === "string" ? parsed.question.trim() : "",
    corpus: parseMaybeJson(parsed.corpus),
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeCorpus(corpus) {
  if (!Array.isArray(corpus)) return [];
  return corpus
    .map((item, index) => ({
      id: stringOrDefault(item?.id, `corpus_${index + 1}`),
      title: stringOrDefault(item?.title, `Corpus ${index + 1}`),
      text: typeof item?.text === "string" ? item.text.trim() : "",
    }))
    .filter((item) => item.text.length > 0);
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function terms(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .map(normalizeTerm)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

function normalizeTerm(term) {
  if (["retained", "retains", "retention"].includes(term)) return "retain";
  if (["backups"].includes(term)) return "backup";
  if (["requested", "requests", "requesting"].includes(term)) return "request";
  if (["restores", "restored", "restoring"].includes(term)) return "restore";
  if (term.endsWith("s") && term.length > 4) return term.slice(0, -1);
  return term;
}

function splitSentences(item) {
  return item.text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence, index) => ({
      source_id: item.id,
      title: item.title,
      sentence_index: index + 1,
      quote: sentence,
      term_set: new Set(terms(sentence)),
    }));
}

function scoreSentence(sentence, questionTerms) {
  let score = 0;
  for (const term of questionTerms) {
    if (sentence.term_set.has(term)) score += 1;
  }
  return score;
}

function selectEvidence(question, corpus) {
  const questionTerms = [...new Set(terms(question))];
  const minimumScore = Math.max(1, Math.min(2, Math.ceil(questionTerms.length * 0.25)));
  return corpus
    .flatMap(splitSentences)
    .map((sentence) => ({
      ...sentence,
      score: scoreSentence(sentence, questionTerms),
    }))
    .filter((sentence) => sentence.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.source_id.localeCompare(b.source_id) || a.sentence_index - b.sentence_index)
    .slice(0, 3);
}

function buildGroundedAnswer(evidence) {
  const citations = evidence.map(({ source_id, title, sentence_index, quote }) => ({
    source_id,
    title,
    sentence_index,
    quote,
  }));
  return {
    answer: {
      text: citations.map((citation) => citation.quote).join(" "),
      citations,
    },
    kb_gaps: [],
    grounded: true,
  };
}

function buildRefusal(question, corpus, reason) {
  return {
    answer: {
      text: "",
      citations: [],
    },
    kb_gaps: [
      reason,
      `No supplied corpus item directly supports: ${question}`,
      `Corpus items checked: ${corpus.map((item) => item.id).join(", ") || "none"}`,
    ],
    grounded: false,
  };
}

function writeFailure(reason, message) {
  process.stderr.write(`${JSON.stringify({ error: { reason, message } })}\n`);
  process.exitCode = 2;
}

function main() {
  const { question, corpus: rawCorpus } = readInputs();
  const corpus = normalizeCorpus(rawCorpus);
  if (!question) {
    writeFailure("missing_question", "question is required and must not be empty");
    return;
  }
  if (corpus.length === 0) {
    process.stdout.write(`${JSON.stringify(buildRefusal(question, corpus, "corpus is required and must include readable text"))}\n`);
    return;
  }
  const evidence = selectEvidence(question, corpus);
  const result = evidence.length > 0
    ? buildGroundedAnswer(evidence)
    : buildRefusal(question, corpus, "no grounded answer found in supplied corpus");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  writeFailure("invalid_input", error instanceof Error ? error.message : String(error));
}
