import fs from "node:fs";

const input = readInputs();
const event = obj(input.event);
const title = text(event.title);
const sources = [
  ...toSources("attendee_note", input.attendee_notes),
  ...toSources("thread", input.thread_snippets),
  ...toSources("public_link", input.public_links),
];

if (!title || sources.length === 0) {
  emit({
    status: "needs_more_context",
    agenda: [],
    decisions: [],
    risks: [],
    questions: ["Provide an event title plus at least one bounded note, snippet, or public link."],
    follow_ups: [],
    citations: [],
    evidence: { stop_reason: "insufficient bounded context" },
  });
}

emit({
  status: "ready",
  agenda: [{ topic: title, reason: "Meeting title defines the main prep area.", citations: sources.slice(0, 2).map((item) => item.id) }, ...sources.filter(actionLike).slice(0, 3).map((item) => ({ topic: summarize(item.body), reason: "Supplied context contains an action or discussion signal.", citations: [item.id] }))],
  decisions: sources.filter((item) => /decid|approved|choose|selected/i.test(item.body)).map((item) => ({ decision: summarize(item.body), citations: [item.id] })),
  risks: sources.filter((item) => /risk|blocked|delay|unknown|concern|issue/i.test(item.body)).map((item) => ({ risk: summarize(item.body), citations: [item.id] })),
  questions: questionItems(sources),
  follow_ups: sources.filter((item) => /follow|todo|next|send|review|share/i.test(item.body)).map((item) => ({ action: summarize(item.body), citations: [item.id] })),
  citations: sources.map((item) => ({ id: item.id, label: item.label, source: item.source })),
  evidence: { event_title: title, bounded_sources: sources.length, private_context_claimed: false },
});

function toSources(kind, raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((entry, index) => {
    const id = text(entry?.id) || `${kind}_${index + 1}`;
    const body = text(entry?.summary) || text(entry?.body) || text(entry?.title) || text(entry?.url) || String(entry);
    return { id, kind, label: `${kind}:${id}`, body, source: text(entry?.url) || text(entry?.link) || id };
  });
}
function questionItems(items) {
  const found = items.filter((item) => /\?|question|clarify|confirm/i.test(item.body)).map((item) => ({ question: summarize(item.body).replace(/\?*$/, "?"), citations: [item.id] }));
  return found.length ? found : [{ question: "What decision should be made by the end of this meeting?", citations: [] }];
}
function actionLike(item) { return /agenda|decision|risk|question|follow|todo|review|block|next/i.test(item.body); }
function summarize(value) { const clean = String(value || "").replace(/\s+/g, " ").trim(); return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean; }
function readInputs() { if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")); if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON); return {}; }
function obj(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }

