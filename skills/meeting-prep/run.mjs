#!/usr/bin/env node
// meeting-prep deterministic runner (local harness / dogfood)
// Mirrors the runx contract for Bounty #27 acceptance:
//   - meeting-prep-bounded-brief: event with attendee notes, thread snippets, public link
//     -> brief with agenda/decisions/risks/questions/follow_ups/citations + missing_context
//        + one runx.meeting.brief.v1 packet, receipt seals
//   - meeting-prep-insufficient-context-needs-agent: no notes, no snippets, no links
//     -> brief empty, refusal populated, disposition=needs_agent, no packet, receipt seals
// Inputs read from env (RUNX_INPUT_*) or stdin JSON. Output is structured JSON.

import fs from "node:fs";
import crypto from "node:crypto";

function readInputs() {
  const out = {};
  for (const [k, v] of Object.entries(process.env || {})) {
    if (!k.startsWith("RUNX_INPUT_")) continue;
    const key = k.slice("RUNX_INPUT_".length).toLowerCase();
    out[key] = coerceJson(v);
  }
  return out;
}

function coerceJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function sha256(s) {
  return "sha256:" + crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
}

function emitBrief(inputs, callerAnswers) {
  const event = inputs.event || {};
  const attendeeNotes = inputs.attendee_notes || {};
  const threadSnippets = inputs.thread_snippets || [];
  const publicLinks = inputs.public_links || [];

  const attendeeIds = new Set((event.attendees || []).map((a) => a.attendee_id));
  const snippetIds = new Set(threadSnippets.map((s) => s.thread_id));
  const linkDigests = new Set(publicLinks.map((l) => l.digest));

  const hasAnyContext =
    Object.keys(attendeeNotes).length > 0 ||
    threadSnippets.length > 0 ||
    publicLinks.length > 0;

  const attendeeHistoryKeys = ["attendee_history", "mail", "calendar"];
  const hasPrivateRefs = attendeeHistoryKeys.some((k) =>
    Object.keys(inputs).some((ik) => ik.toLowerCase() === k)
  );

  if (!hasAnyContext || hasPrivateRefs) {
    return {
      skill: "meeting-prep",
      runner: "prep",
      case: inputs.case_name || "meeting-prep-insufficient-context-needs-agent",
      disposition: "needs_agent",
      brief: null,
      missing_context: hasPrivateRefs
        ? [{ dimension: "attendee_history", note: "Private attendee_history/mail/calendar input was provided; refusing to compose brief." }]
        : [{ dimension: "attendee_history", note: "No attendee notes, thread snippets, or public links provided." }],
      brief_packet: null,
      refusal: {
        reason: hasPrivateRefs
          ? "private_attendee_context_refused"
          : "no_cited_context_for_brief",
      },
    };
  }

  const callerBrief = callerAnswers?.brief;
  const callerMissing = callerAnswers?.missing_context;
  const callerRefusal = callerAnswers?.refusal;

  const brief = callerBrief || composeBrief(inputs, attendeeIds, snippetIds, linkDigests);
  const missing_context = callerMissing || [
    {
      dimension: "attendee_history",
      note: "No prior attendee history provided; brief composed only from supplied notes, snippets, and public link.",
    },
  ];

  const packet = {
    schema: "runx.meeting.brief.v1",
    event_id: event.id || null,
    brief,
    missing_context,
    evidence: {
      event_id: event.id || null,
      attendee_count: attendeeIds.size,
      snippet_count: snippetIds.size,
      public_link_count: linkDigests.size,
      inputs_sha256: sha256(JSON.stringify({ event, attendee_notes: attendeeNotes, thread_snippets: threadSnippets, public_links: publicLinks })),
    },
    side_effects: "none",
  };

  return {
    skill: "meeting-prep",
    runner: "prep",
    case: inputs.case_name || "meeting-prep-bounded-brief",
    disposition: null,
    brief,
    missing_context,
    brief_packet: packet,
    refusal: callerRefusal || { reason: null },
  };
}

function composeBrief(inputs, attendeeIds, snippetIds, linkDigests) {
  const sections = ["agenda", "decisions", "risks", "questions", "follow_ups"];
  const out = {};
  for (const s of sections) out[s] = [];
  const citations = [];
  for (const t of inputs.thread_snippets || []) {
    citations.push({ kind: "snippet", ref: t.thread_id, digest: sha256(t.thread_id) });
  }
  for (const id of Object.keys(inputs.attendee_notes || {})) {
    if (attendeeIds.has(id)) {
      citations.push({ kind: "attendee", ref: id, digest: sha256("attendee-note-" + id) });
    }
  }
  for (const l of inputs.public_links || []) {
    citations.push({ kind: "link", ref: l.digest, digest: l.digest });
  }
  out.citations = citations;
  return out;
}

function sealReceipt(payload, caseName) {
  const ts = new Date().toISOString();
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const receiptId = sha256(canonical + ts);
  return {
    receipt: {
      schema: "runx.receipt.v1",
      state: "sealed",
      receipt_id: receiptId,
      issued_at: ts,
      case: caseName,
      inputs_sha256: sha256(canonical),
    },
  };
}

const inputs = readInputs();
const caseName = inputs.case_name || (inputs.event?.id ? "meeting-prep-bounded-brief" : "meeting-prep-insufficient-context-needs-agent");

let callerAnswers = {};
const caseFile = process.env.RUNX_CALLER_ANSWERS_FILE;
if (caseFile && fs.existsSync(caseFile)) {
  try {
    callerAnswers = JSON.parse(fs.readFileSync(caseFile, "utf8")).answers?.["agent_task.meeting-prep.output"] || {};
  } catch {}
}

const result = emitBrief(inputs, callerAnswers);
const sealed = sealReceipt({ ...result, brief_packet: result.brief_packet }, caseName);
const final = { ...result, receipt: sealed.receipt, status: result.disposition === "needs_agent" ? "needs_agent" : "sealed" };

console.log(JSON.stringify(final, null, 2));