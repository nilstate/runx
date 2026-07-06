import fs from "node:fs";
import crypto from "node:crypto";

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  const parsed = JSON.parse(raw);
  return {
    transcript: typeof parsed.transcript === "string" ? parsed.transcript : String(parsed.transcript || ""),
    attendees: parseMaybeJson(parsed.attendees),
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{"]/.test(trimmed)) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizeAttendees(attendees) {
  if (!Array.isArray(attendees)) {
    return [];
  }
  return attendees
    .map((attendee) => {
      if (typeof attendee === "string") return attendee.trim();
      if (attendee && typeof attendee === "object" && typeof attendee.name === "string") return attendee.name.trim();
      return "";
    })
    .filter(Boolean);
}

function splitLines(transcript) {
  return transcript
    .split(/\r?\n/)
    .map((raw, index) => {
      const line = raw.trim();
      const match = line.match(/^([^:]{1,80}):\s*(.+)$/);
      return {
        line_number: index + 1,
        speaker: match ? match[1].trim() : null,
        text: match ? match[2].trim() : line,
        raw: line,
      };
    })
    .filter((line) => line.raw);
}

function attendeeSet(attendees) {
  return new Map(attendees.map((name) => [name.toLowerCase(), name]));
}

function resolveOwner(line, attendeesByLower) {
  const text = line.text;
  if (line.speaker && attendeesByLower.has(line.speaker.toLowerCase()) && /\bI\s+will\b/i.test(text)) {
    return attendeesByLower.get(line.speaker.toLowerCase());
  }
  for (const [lower, canonical] of attendeesByLower.entries()) {
    const pattern = new RegExp(`\\b${escapeRegExp(canonical)}\\b\\s+(?:will|to|owns|owner)\\b`, "i");
    if (pattern.test(text)) {
      return canonical;
    }
    const ownerPattern = new RegExp(`\\bowner\\s*[:=]\\s*${escapeRegExp(canonical)}\\b`, "i");
    if (ownerPattern.test(text)) {
      return canonical;
    }
    if (text.toLowerCase().startsWith(`${lower}:`)) {
      return canonical;
    }
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDue(text) {
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const phrase = text.match(/\b(?:by|before|on|due)\s+((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|eod|end of week))\b/i);
  if (phrase) return phrase[1].toLowerCase();
  return null;
}

function cleanActionText(line) {
  return line.text
    .replace(/\bI\s+will\b/i, "will")
    .replace(/\bby\s+20\d{2}-\d{2}-\d{2}\b/i, "")
    .replace(/\b(?:by|before|on|due)\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|eod|end of week)\b/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^will\s+/i, "")
    .replace(/\s+([.,;:!?])$/g, "$1");
}

function decisionText(text) {
  return text
    .replace(/^\s*(?:we\s+)?(?:decided|decision|agreed)\s+(?:that|to)?\s*/i, "")
    .replace(/^\s*we\s+will\s+/i, "")
    .trim();
}

function extractDecisions(lines) {
  return lines
    .filter((line) => /\b(decided|decision|agreed|we will)\b/i.test(line.text))
    .map((line) => ({
      decision: decisionText(line.text),
      source_line: line.line_number,
      speaker: line.speaker,
      confidence: 0.86,
    }))
    .filter((item) => item.decision.length > 0);
}

function isActionLine(text) {
  return /\b(I will|will|please|take|send|prepare|follow up|own|owner)\b/i.test(text);
}

function extractActions(lines, attendees) {
  const byLower = attendeeSet(attendees);
  return lines
    .filter((line) => isActionLine(line.text))
    .map((line) => {
      const owner = resolveOwner(line, byLower);
      const due = extractDue(line.text);
      const missing = [];
      if (!owner) missing.push("owner");
      if (!due) missing.push("due");
      return {
        task: cleanActionText(line),
        owner,
        due,
        source_line: line.line_number,
        speaker: line.speaker,
        status: missing.length === 0 ? "ready_for_proposal" : "needs_human_assignment",
        missing,
        confidence: missing.length === 0 ? 0.9 : 0.55,
      };
    })
    .filter((item) => item.task.length > 0);
}

function buildTaskProposals(actionItems) {
  return actionItems
    .filter((item) => item.owner && item.due)
    .map((item, index) => ({
      proposal_id: `task_proposal_${String(index + 1).padStart(2, "0")}`,
      handoff_target: "n8n-handoff",
      live_task_created: false,
      title: item.task,
      owner: item.owner,
      due: item.due,
      source_line: item.source_line,
      acceptance_gate: "human-review-before-live-task-write",
    }));
}

function main() {
  const { transcript, attendees: rawAttendees } = readInputs();
  const attendees = normalizeAttendees(rawAttendees);
  const lines = splitLines(transcript);
  if (!transcript.trim()) {
    return writeRefusal("empty_transcript", attendees, lines);
  }
  if (attendees.length === 0) {
    return writeRefusal("missing_attendees", attendees, lines);
  }

  const decisions = extractDecisions(lines);
  const action_items = extractActions(lines, attendees);
  const task_proposals = buildTaskProposals(action_items);
  const actionable = decisions.length > 0 || action_items.length > 0 || task_proposals.length > 0;
  const status = actionable ? "completed" : "refused";
  const summary = {
    status,
    digest: sha256({ transcript, attendees }),
    attendee_count: attendees.length,
    source_line_count: lines.length,
    decision_count: decisions.length,
    action_item_count: action_items.length,
    task_proposal_count: task_proposals.length,
    note: actionable
      ? `Extracted ${decisions.length} decisions and ${action_items.length} action items without creating live tasks.`
      : "No explicit decisions, owners, due dates, or task proposals were found.",
  };

  process.stdout.write(`${JSON.stringify({
    summary,
    decisions,
    action_items,
    task_proposals,
  })}\n`);
}

function writeRefusal(reason, attendees, lines) {
  process.stdout.write(`${JSON.stringify({
    summary: {
      status: "refused",
      reason,
      attendee_count: attendees.length,
      source_line_count: lines.length,
      decision_count: 0,
      action_item_count: 0,
      task_proposal_count: 0,
      note: "The skill refuses to invent meeting follow-up content from insufficient input.",
    },
    decisions: [],
    action_items: [],
    task_proposals: [],
  })}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    summary: {
      status: "refused",
      reason: "invalid_input",
      error: message,
      decision_count: 0,
      action_item_count: 0,
      task_proposal_count: 0,
    },
    decisions: [],
    action_items: [],
    task_proposals: [],
  })}\n`);
}
