export function finalizeGroundedAnswer(inputs) {
  const question = text(inputs.question);
  const corpusDigest = text(inputs.corpus_digest);
  const corpusResult = indexCorpus(inputs.corpus);

  if (!question) return refused(question, corpusDigest, ["question is missing"]);
  if (!/^sha256:[0-9a-f]{64}$/u.test(corpusDigest || "")) {
    return refused(question, null, ["native corpus digest is missing"]);
  }
  if (corpusResult.findings.length > 0) {
    return refused(question, corpusDigest, corpusResult.findings);
  }

  const draft = record(inputs.answer_draft);
  const decision = text(draft.decision);
  const answer = record(draft.answer);
  const answerText = text(answer.text) || "";
  const citations = Array.isArray(answer.citations) ? answer.citations : [];
  const kbGaps = strings(draft.kb_gaps);
  const conflicts = strings(draft.conflicts);

  if (decision === "unsupported" || decision === "conflicted") {
    const findings = [];
    if (answerText || citations.length > 0) {
      findings.push(`${decision} results cannot include an answer or citations`);
    }
    if (decision === "unsupported" && kbGaps.length === 0) {
      findings.push("unsupported results require at least one knowledge-base gap");
    }
    if (decision === "conflicted" && conflicts.length === 0) {
      findings.push("conflicted results require at least one conflict");
    }
    if (findings.length > 0) return refused(question, corpusDigest, findings);
    return {
      grounded_answer: packet({
        question,
        decision,
        grounded: false,
        answer: { text: "", citations: [] },
        kb_gaps: kbGaps,
        conflicts,
        corpus_digest: corpusDigest,
        validation: { status: "pass", findings: [] },
      }),
    };
  }

  if (decision !== "answered") {
    return refused(question, corpusDigest, ["decision must be answered, unsupported, or conflicted"]);
  }

  const findings = [];
  if (!answerText) findings.push("answered results require non-empty answer text");
  if (citations.length === 0) findings.push("answered results require at least one citation");
  if (kbGaps.length > 0) findings.push("answered results cannot include knowledge-base gaps");
  if (conflicts.length > 0) findings.push("answered results cannot include unresolved conflicts");

  const canonicalCitations = [];
  for (const rawCitation of citations) {
    const citation = record(rawCitation);
    const sourceId = text(citation.source_id);
    const quote = text(citation.quote);
    const source = sourceId ? corpusResult.sources.get(sourceId) : null;
    if (!source) {
      findings.push(`citation names unknown source: ${sourceId || "<missing>"}`);
      continue;
    }
    if (!quote || !source.text.includes(quote)) {
      findings.push(`citation quote is not present in source: ${sourceId}`);
      continue;
    }
    canonicalCitations.push({ source_id: source.id, title: source.title, quote });
  }

  if (findings.length > 0) return refused(question, corpusDigest, findings);
  return {
    grounded_answer: packet({
      question,
      decision: "answered",
      grounded: true,
      answer: { text: answerText, citations: canonicalCitations },
      kb_gaps: [],
      conflicts: [],
      corpus_digest: corpusDigest,
      validation: { status: "pass", findings: [] },
    }),
  };
}

function indexCorpus(value) {
  const sources = new Map();
  const findings = [];
  if (!Array.isArray(value) || value.length === 0) {
    return { sources, findings: ["corpus must be a non-empty array"] };
  }
  for (const rawSource of value) {
    const source = record(rawSource);
    const id = text(source.id);
    const title = text(source.title);
    const body = text(source.text);
    if (!id || !title || !body) {
      findings.push("every corpus source requires non-empty id, title, and text");
      continue;
    }
    if (sources.has(id)) {
      findings.push(`duplicate corpus source id: ${id}`);
      continue;
    }
    sources.set(id, { id, title, text: body });
  }
  return { sources, findings };
}

function refused(question, corpusDigest, findings) {
  return {
    grounded_answer: packet({
      question: question || "",
      decision: "unsupported",
      grounded: false,
      answer: { text: "", citations: [] },
      kb_gaps: ["Correct the supplied evidence before answering."],
      conflicts: [],
      corpus_digest: corpusDigest,
      validation: { status: "fail", findings },
    }),
  };
}

function packet(data) {
  return { schema: "runx.grounded_answer.v1", ...data };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}
