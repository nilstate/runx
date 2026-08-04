export function admitMeeting(inputs) {
  const transcript = text(inputs.transcript);
  const attendeeResult = normalizeAttendees(inputs.attendees);
  const findings = [...attendeeResult.findings];
  if (!transcript) findings.push("transcript must be a non-empty string");

  const lines = transcript ? transcript.split(/\r?\n/u)
    .map((raw, index) => sourceLine(raw, index + 1))
    .filter((line) => line.raw) : [];
  if (transcript && lines.length === 0) findings.push("transcript has no readable lines");

  return {
    meeting_evidence: {
      path: findings.length === 0 ? "synthesize" : "stop",
      attendees: attendeeResult.attendees,
      lines,
      findings,
    },
  };
}

export function finalizeMeeting(inputs) {
  const evidence = record(inputs.meeting_evidence);
  const evidenceDigest = text(inputs.evidence_digest);
  const baseFindings = Array.isArray(evidence.findings) ? strings(evidence.findings) : [];
  if (!/^sha256:[0-9a-f]{64}$/u.test(evidenceDigest || "")) {
    baseFindings.push("native evidence digest is missing");
  }
  if (evidence.path !== "synthesize") {
    return output("needs_input", "", [], [], [], baseFindings, evidenceDigest, "fail");
  }

  const draft = record(inputs.followup_draft);
  const draftDecision = text(draft.decision);
  const draftDecisions = Array.isArray(draft.decisions) ? draft.decisions : [];
  const draftActions = Array.isArray(draft.action_items) ? draft.action_items : [];
  const issues = strings(draft.issues);

  if (draftDecision === "no_followup") {
    const findings = [...baseFindings];
    if (draftDecisions.length || draftActions.length) {
      findings.push("no_followup cannot include decisions or action items");
    }
    if (findings.length) {
      return output("needs_clarification", "", [], [], issues, findings, evidenceDigest, "fail");
    }
    return output(
      "no_followup",
      "No explicit decision or commitment was identified in the supplied meeting record.",
      [],
      [],
      issues,
      [],
      evidenceDigest,
      "pass",
    );
  }

  if (!["ready", "needs_clarification"].includes(draftDecision)) {
    return output(
      "needs_clarification",
      "",
      [],
      [],
      issues,
      [...baseFindings, "decision must be ready, no_followup, or needs_clarification"],
      evidenceDigest,
      "fail",
    );
  }

  const lineIndex = indexLines(evidence.lines);
  const attendeeIndex = indexAttendees(evidence.attendees);
  const findings = [...baseFindings];
  const derivedIssues = [...issues];
  const decisions = [];
  const actionItems = [];
  const decisionKeys = new Set();
  const actionKeys = new Set();

  for (const rawDecision of draftDecisions) {
    const item = record(rawDecision);
    const decisionText = text(item.text);
    const source = validateEvidence(item.evidence, lineIndex);
    if (!decisionText) findings.push("every decision requires non-empty text");
    if (!source.valid) findings.push(...source.findings);
    if (decisionText && source.valid) {
      const key = `${source.evidence.line_number}:${decisionText}`;
      if (!decisionKeys.has(key)) {
        decisionKeys.add(key);
        decisions.push({ text: decisionText, evidence: source.evidence });
      }
    }
  }

  for (const rawAction of draftActions) {
    const item = record(rawAction);
    const task = text(item.task);
    const source = validateEvidence(item.evidence, lineIndex);
    if (!task) findings.push("every action item requires non-empty task text");
    if (!source.valid) findings.push(...source.findings);
    if (!task || !source.valid) continue;

    const ownerInput = text(item.owner);
    const rosterOwner = ownerInput ? attendeeIndex.get(ownerInput.toLowerCase()) || null : null;
    const owner = rosterOwner && ownerSupportedByEvidence(rosterOwner, source.evidence)
      ? rosterOwner : null;
    const dueInput = text(item.due);
    const due = dueInput && validIsoDate(dueInput)
      && source.evidence.quote.includes(dueInput) ? dueInput : null;
    const missing = [];
    if (!owner) {
      missing.push("owner");
      derivedIssues.push(rosterOwner
        ? `Owner '${rosterOwner}' is not the speaker or explicitly named in the cited line.`
        : ownerInput
          ? `Owner '${ownerInput}' is not in the attendee roster.`
        : `Action on line ${source.evidence.line_number} needs an owner.`);
    }
    if (!due) {
      missing.push("due");
      derivedIssues.push(dueInput
        ? `Due value '${dueInput}' is not an explicit valid ISO date in the cited line.`
        : `Action on line ${source.evidence.line_number} needs an explicit ISO due date.`);
    }
    const normalized = {
      task,
      owner,
      owner_text: ownerInput,
      due,
      due_text: dueInput,
      evidence: source.evidence,
      missing,
      status: missing.length === 0 ? "ready_for_proposal" : "needs_human_assignment",
    };
    const key = `${source.evidence.line_number}:${task}`;
    if (!actionKeys.has(key)) {
      actionKeys.add(key);
      actionItems.push(normalized);
    }
  }

  if (draftDecision === "ready" && decisions.length === 0 && actionItems.length === 0) {
    findings.push("ready requires at least one grounded decision or action item");
  }
  if (draftDecision === "needs_clarification" && derivedIssues.length === 0) {
    findings.push("needs_clarification requires at least one explicit issue");
  }
  decisions.sort((left, right) => left.evidence.line_number - right.evidence.line_number);
  actionItems.sort((left, right) => left.evidence.line_number - right.evidence.line_number);
  const summary = buildSummary(decisions, actionItems);
  if (findings.length) {
    return output(
      "needs_clarification",
      summary,
      decisions,
      actionItems,
      derivedIssues,
      findings,
      evidenceDigest,
      "fail",
    );
  }
  const taskProposals = (draftDecision === "ready" ? actionItems : [])
    .filter((item) => item.missing.length === 0)
    .map((item, index) => ({
      proposal_id: `task_proposal_${String(item.evidence.line_number).padStart(2, "0")}_${String(index + 1).padStart(2, "0")}`,
      operation: "task.create",
      title: item.task,
      owner: item.owner,
      due: item.due,
      evidence: item.evidence,
      effect_status: "not_created",
    }));
  const incomplete = actionItems.some((item) => item.missing.length > 0);
  const decision = draftDecision === "needs_clarification" || incomplete
    ? "needs_clarification" : "ready";
  const followupMessage = decision === "ready"
    ? buildFollowupMessage(summary, decisions, actionItems, evidence.attendees)
    : null;
  return output(
    decision,
    summary,
    decisions,
    actionItems,
    derivedIssues,
    [],
    evidenceDigest,
    "pass",
    taskProposals,
    followupMessage,
  );
}

function output(
  decision,
  summary,
  decisions,
  actionItems,
  issues,
  findings,
  evidenceDigest,
  validationStatus,
  taskProposals = [],
  followupMessage = null,
) {
  return {
    meeting_followup: {
      decision,
      summary,
      decisions,
      action_items: actionItems,
      task_proposals: taskProposals,
      followup_message: followupMessage,
      issues,
      evidence_digest: evidenceDigest || null,
      validation: { status: validationStatus, findings },
    },
  };
}

function buildFollowupMessage(summary, decisions, actionItems, attendees) {
  const body = [summary];
  if (decisions.length > 0) {
    body.push("", "Decisions", ...decisions.map((item) => `- ${item.text}`));
  }
  if (actionItems.length > 0) {
    body.push(
      "",
      "Action items",
      ...actionItems.map((item) => `- ${item.task}; owner ${item.owner}; due ${item.due}`),
    );
  }
  return {
    subject: "Meeting follow-up",
    body: body.join("\n"),
    recipient_names: strings(attendees),
    delivery_status: "not_sent",
  };
}

function buildSummary(decisions, actionItems) {
  const parts = [];
  if (decisions.length > 0) {
    parts.push(`Decisions: ${decisions.map((item) => item.text).join("; ")}.`);
  }
  if (actionItems.length > 0) {
    parts.push(`Action items: ${actionItems.map((item) => item.task).join("; ")}.`);
  }
  return parts.join(" ");
}

function validateEvidence(value, lines) {
  const evidence = record(value);
  const lineNumber = Number(evidence.line_number);
  const quote = text(evidence.quote);
  const line = Number.isInteger(lineNumber) ? lines.get(lineNumber) : null;
  const findings = [];
  if (!line) findings.push(`evidence names unknown line: ${lineNumber || "<missing>"}`);
  if (!quote || !line || quote !== line.text) {
    findings.push(`evidence quote must match the complete source line: ${lineNumber || "<missing>"}`);
  }
  return {
    valid: findings.length === 0,
    findings,
    evidence: line && quote ? {
      line_number: line.line_number,
      speaker: line.speaker,
      quote,
    } : null,
  };
}

function ownerSupportedByEvidence(owner, evidence) {
  if (text(evidence.speaker)?.toLowerCase() === owner.toLowerCase()) return true;
  return containsDelimitedName(evidence.quote, owner);
}

function containsDelimitedName(value, name) {
  const source = String(value || "").toLowerCase();
  const target = String(name || "").toLowerCase();
  if (!source || !target) return false;
  let offset = source.indexOf(target);
  while (offset >= 0) {
    const before = offset === 0 ? "" : source[offset - 1];
    const afterIndex = offset + target.length;
    const after = afterIndex >= source.length ? "" : source[afterIndex];
    if (nameBoundary(before) && nameBoundary(after)) return true;
    offset = source.indexOf(target, offset + 1);
  }
  return false;
}

function nameBoundary(value) {
  return !value || /[\s,.;:!?()[\]{}<>"'`/\\|–—-]/u.test(value);
}

function sourceLine(raw, lineNumber) {
  const value = String(raw || "").trim();
  const match = value.match(/^([^:]{1,80}):\s*(.+)$/u);
  return {
    line_number: lineNumber,
    speaker: match ? match[1].trim() : null,
    text: match ? match[2].trim() : value,
    raw: value,
  };
}

function normalizeAttendees(value) {
  const findings = [];
  const attendees = [];
  const seen = new Set();
  if (!Array.isArray(value) || value.length === 0) {
    return { attendees, findings: ["attendees must be a non-empty array"] };
  }
  for (const raw of value) {
    const name = text(typeof raw === "string" ? raw : record(raw).name);
    if (!name) {
      findings.push("every attendee requires a non-empty name");
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      findings.push(`duplicate attendee: ${name}`);
      continue;
    }
    seen.add(key);
    attendees.push(name);
  }
  return { attendees, findings };
}

function indexLines(value) {
  const result = new Map();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const line = record(raw);
      if (Number.isInteger(line.line_number)) result.set(line.line_number, line);
    }
  }
  return result;
}

function indexAttendees(value) {
  return new Map(strings(value).map((name) => [name.toLowerCase(), name]));
}

function validIsoDate(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
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
