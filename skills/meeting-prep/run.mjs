import fs from "node:fs";

const inputs = readInputs();
const event = object(inputs.event, "event");
const attendeeNotes = optionalArray(inputs.attendee_notes, "attendee_notes");
const threadSnippets = optionalArray(inputs.thread_snippets, "thread_snippets");
const publicLinks = optionalArray(inputs.public_links, "public_links");
const prepGoal = text(inputs.prep_goal) || "general meeting readiness";

const sourceMap = new Map();
for (const item of attendeeNotes) addSource(item, "attendee_note");
for (const item of threadSnippets) addSource(item, "thread_snippet");
for (const item of publicLinks) addSource(item, "public_link");

const eventTitle = text(event.title);
if (!eventTitle) fail("event.title is required");

const boundedContextCount = sourceMap.size;
const eventPurpose = text(event.purpose);
const agendaItems = Array.isArray(event.agenda_items) ? event.agenda_items.map(text).filter(Boolean) : [];
if (boundedContextCount < 2 || (!eventPurpose && agendaItems.length === 0)) {
  fail("insufficient bounded context: provide event purpose or agenda plus at least two cited notes/snippets/links");
}

const attendees = Array.isArray(event.attendees) ? event.attendees.filter(isObject) : [];
const allSources = [...sourceMap.values()];
const blockerSources = allSources.filter((source) => /blocker|risk|unresolved|concern|timeline|decision|renewal|owner|beta/i.test(source.text));
const citedSourceIds = new Set();

const agenda = buildAgenda();
const decisions = buildDecisions();
const risks = buildRisks();
const questions = buildQuestions();
const followUps = buildFollowUps();
const citations = [...citedSourceIds].sort().map((id) => {
  const source = sourceMap.get(id);
  return {
    id,
    kind: source.kind,
    label: source.label,
    url: source.url || null,
  };
});

emit({
  agenda,
  decisions,
  risks,
  questions,
  follow_ups: followUps,
  citations,
  bounds: {
    event_title: eventTitle,
    prep_goal: prepGoal,
    provided_source_count: boundedContextCount,
    private_context_read: false,
    external_effects_emitted: [],
  },
});

function buildAgenda() {
  const items = [];
  items.push({
    order: 1,
    topic: eventPurpose || `Align on ${eventTitle}`,
    reason: "stated_event_purpose",
    citations: citeAll(firstIds(2)),
  });
  let order = 2;
  for (const item of agendaItems.slice(0, 4)) {
    items.push({
      order,
      topic: item,
      reason: "provided_event_agenda",
      citations: citeAll(firstIds(2)),
    });
    order += 1;
  }
  if (blockerSources.length) {
    items.push({
      order,
      topic: "Resolve named blockers and owners",
      reason: "bounded_context_mentions_blockers_or_decisions",
      citations: citeAll(blockerSources.slice(0, 3).map((s) => s.id)),
    });
  }
  items.push({
    order: order + 1,
    topic: "Confirm next steps, owner, and follow-up deadline",
    reason: "operator_meeting_closeout",
    citations: citeAll(firstIds(2)),
  });
  return items;
}

function buildDecisions() {
  const decisions = [];
  const decisionSources = allSources.filter((source) => /decide|decision|renewal|offer|owner|approve|next friday/i.test(source.text));
  for (const source of decisionSources.slice(0, 4)) {
    decisions.push({
      decision: summarizeDecision(source.text),
      why_now: "Source text indicates a pending decision or owner.",
      citations: citeAll([source.id]),
    });
  }
  if (!decisions.length) {
    decisions.push({
      decision: "Confirm whether this meeting is informational or decision-making.",
      why_now: "No explicit decision source was provided.",
      citations: citeAll(firstIds(2)),
    });
  }
  return decisions;
}

function buildRisks() {
  const risks = [];
  for (const source of blockerSources.slice(0, 5)) {
    risks.push({
      risk: summarizeRisk(source.text),
      mitigation: "Ask for owner, deadline, and evidence needed to unblock.",
      citations: citeAll([source.id]),
    });
  }
  risks.push({
    risk: "Private history may be incomplete because only caller-supplied context was used.",
    mitigation: "Bring any missing calendar, mail, CRM, or prior-call notes into the bounded packet before relying on the brief.",
    citations: [],
  });
  return risks;
}

function buildQuestions() {
  const questions = [
    {
      question: `What outcome would make '${eventTitle}' successful for each attendee?`,
      reason: "align_on_success_criteria",
      citations: citeAll(firstIds(2)),
    },
  ];
  for (const source of blockerSources.slice(0, 4)) {
    questions.push({
      question: questionFromSource(source.text),
      reason: "clarify_bounded_context_signal",
      citations: citeAll([source.id]),
    });
  }
  for (const attendee of attendees.slice(0, 3)) {
    const name = text(attendee.name) || text(attendee.role);
    if (name) {
      questions.push({
        question: `What does ${name} need to commit to before the next milestone?`,
        reason: "attendee_specific_commitment",
        citations: citeAll(firstIds(2)),
      });
    }
  }
  return dedupeByQuestion(questions).slice(0, 7);
}

function buildFollowUps() {
  return [
    {
      action: "Send a written recap with decisions, owners, due dates, and open risks.",
      owner: text(event.organizer) || "meeting organizer",
      citations: citeAll(firstIds(2)),
    },
    {
      action: "Attach the bounded source packet used for the brief so reviewers can check citations.",
      owner: "operator",
      citations: citeAll([...sourceMap.keys()].slice(0, 4)),
    },
    {
      action: "Schedule or request missing private context only if stakeholders say it is needed.",
      owner: "operator",
      citations: [],
    },
  ];
}

function addSource(item, kind) {
  const source = object(item, `${kind} item`);
  const id = text(source.id) || `${kind}-${sourceMap.size + 1}`;
  const body = text(source.text) || text(source.summary);
  if (!body) return;
  sourceMap.set(id, {
    id,
    kind,
    label: text(source.source) || text(source.subject) || text(source.url) || id,
    text: body,
    url: text(source.url),
  });
}

function firstIds(count) {
  return [...sourceMap.keys()].slice(0, count);
}

function citeAll(ids) {
  const clean = ids.filter((id) => sourceMap.has(id));
  for (const id of clean) citedSourceIds.add(id);
  return clean;
}

function summarizeDecision(value) {
  if (/renewal/i.test(value)) return "Confirm renewal path, decision owner, and acceptance criteria.";
  if (/extension/i.test(value)) return "Decide whether an implementation extension is warranted.";
  if (/owner/i.test(value)) return "Assign a clear owner for the next decision or blocker.";
  return sentence(value);
}

function summarizeRisk(value) {
  if (/sso/i.test(value)) return "SSO mapping may block launch readiness.";
  if (/csv/i.test(value)) return "CSV import validation may delay rollout confidence.";
  if (/timeline/i.test(value)) return "Support timeline may be unclear to stakeholders.";
  if (/beta/i.test(value)) return "A dependency may still be in beta rather than production-ready.";
  return sentence(value);
}

function questionFromSource(value) {
  if (/sso/i.test(value)) return "What exactly remains unresolved in SSO mapping, and who owns the fix?";
  if (/csv/i.test(value)) return "What proof is needed to accept CSV import validation as ready?";
  if (/renewal/i.test(value)) return "What renewal criteria must be met before the decision deadline?";
  if (/timeline/i.test(value)) return "What support timeline is credible and acceptable to the customer?";
  return `What should we do about this signal: ${sentence(value)}`;
}

function sentence(value) {
  return String(value).replace(/\s+/g, " ").trim().replace(/[.?!]?$/, ".");
}

function dedupeByQuestion(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function object(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function optionalArray(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value.filter(isObject);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
