import fs from "node:fs";

// ---------------------------------------------------------------------------
// Module constants (declared up front so all functions can reference them)
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ---------------------------------------------------------------------------
// Read inputs
// ---------------------------------------------------------------------------

const inputs = readInputs();

const meeting = objectValue(inputs.meeting, "meeting");
const policy = inputs.priority_policy ? objectValue(inputs.priority_policy, "priority_policy") : {};

// ---------------------------------------------------------------------------
// Validate required fields
// ---------------------------------------------------------------------------

const notes = stringValue(meeting.notes);
if (!notes) fail("meeting.notes is required and must be a non-empty string");

const meetingDateRaw = stringValue(meeting.meeting_date);
if (!meetingDateRaw) fail("meeting.meeting_date is required");

const meetingDate = parseDate(meetingDateRaw);
if (!meetingDate) fail("meeting.meeting_date must be a valid ISO 8601 date (e.g. 2026-07-09)");

// ---------------------------------------------------------------------------
// Priority policy defaults
// ---------------------------------------------------------------------------

const urgentSignals = Array.isArray(policy.urgent_signals)
  ? policy.urgent_signals.map((s) => String(s).toLowerCase())
  : ["urgent", "asap", "p0", "p1", "critical", "high priority", "right away", "immediately"];

const deferSignals = Array.isArray(policy.defer_signals)
  ? policy.defer_signals.map((s) => String(s).toLowerCase())
  : ["low priority", "backlog", "when time permits", "nice to have", "whenever", "no rush"];

const nearDeadlineHours = typeof policy.near_deadline_hours === "number"
  ? policy.near_deadline_hours
  : 48;

// ---------------------------------------------------------------------------
// Extract action items
// ---------------------------------------------------------------------------

const candidates = extractCandidates(notes);
const actionItems = [];

for (const candidate of candidates) {
  const owner = detectOwner(candidate);
  if (owner && /^principal:/i.test(owner)) {
    fail(`candidate action item names a sensitive principal owner '${owner}' that this skill is not authorized to assign against`);
  }
  const dueDate = detectDueDate(candidate, meetingDate);
  const priority = detectPriority(candidate, dueDate, meetingDate, urgentSignals, deferSignals, nearDeadlineHours);
  const description = cleanDescription(candidate);

  if (!description) continue;

  actionItems.push({
    description,
    owner: owner || "unassigned",
    due_date: dueDate, // ISO date string or null
    priority,
  });
}

if (actionItems.length === 0) {
  fail("no recognizable action items found in the meeting notes; returning to manual review");
}

// ---------------------------------------------------------------------------
// Sort: priority (high -> medium -> low), then due date (earliest first, null last)
// ---------------------------------------------------------------------------

const priorityRank = { high: 0, medium: 1, low: 2 };
actionItems.sort((a, b) => {
  const pr = priorityRank[a.priority] - priorityRank[b.priority];
  if (pr !== 0) return pr;
  if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
  if (a.due_date) return -1;
  if (b.due_date) return 1;
  return 0;
});

// ---------------------------------------------------------------------------
// Summarize and emit
// ---------------------------------------------------------------------------

const summary = summarizeMeeting(notes);

const result = {
  summary,
  action_item_count: actionItems.length,
  action_items: actionItems,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Extraction logic
// ---------------------------------------------------------------------------

function extractCandidates(text) {
  // Split on sentence boundaries and newlines, keeping meaningful chunks.
  const rough = text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Merge fragments that look like continuation (no verb/action signal) with
  // the previous candidate, and keep only candidates that contain an action
  // signal so non-action chatter is dropped early.
  const actionSignals = [
    "will", "to own", "to own", "action:", "follow up", "follow-up", "followup",
    "needs to", "need to", "should", "must", "responsible for", "owns",
    "to do", "todo", "task:", "take care of", "drive", "lead",
    "@", "by monday", "by tuesday", "by wednesday", "by thursday", "by friday",
    "by eow", "by next", "by tomorrow", "asap", "urgent",
  ];

  const candidates = [];
  for (const chunk of rough) {
    const lower = chunk.toLowerCase();
    const hasSignal = actionSignals.some((sig) => lower.includes(sig));
    if (hasSignal) {
      candidates.push(chunk);
    }
  }
  return candidates;
}

function detectOwner(candidate) {
  const lower = candidate.toLowerCase();

  // @mention style
  const mentionMatch = candidate.match(/@([A-Za-z][A-Za-z0-9._-]*)/);
  if (mentionMatch) return capitalizeName(mentionMatch[1]);

  // "ACTION: Name ..." / "Task: Name ..."
  const actionOwnerMatch = candidate.match(/(?:action|task)\s*:\s*([A-Z][a-zA-Z]+)\s+(?:will|to|should|needs?|must)/);
  if (actionOwnerMatch) return actionOwnerMatch[1];

  // "Name will ..." / "Name to own ..." / "Name to ..." / "Name needs to ..."
  const nameVerbMatch = candidate.match(/\b([A-Z][a-z]+)\s+(?:will|to\s+own|to\s+do|to\s+follow|needs?\s+to|must|should|is\s+responsible|owns?)\b/);
  if (nameVerbMatch) return nameVerbMatch[1];

  // "... by Name" after an action verb — less reliable, skip unless clearly an owner
  // "Alice is responsible for ..."
  const responsibleMatch = candidate.match(/\b([A-Z][a-z]+)\s+is\s+responsible\s+for\b/);
  if (responsibleMatch) return responsibleMatch[1];

  // "Name to own ..."
  const toOwnMatch = candidate.match(/\b([A-Z][a-z]+)\s+to\s+own\b/);
  if (toOwnMatch) return toOwnMatch[1];

  return null;
}

function detectDueDate(candidate, meetingDate) {
  const lower = candidate.toLowerCase();

  // Absolute ISO date: 2026-07-12
  const isoMatch = candidate.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const d = safeDate(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    if (d) return isoDate(d);
  }

  // "July 12" / "Jul 12"
  const monthDayMatch = candidate.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthDayMatch) {
    const monthIdx = monthIndex(monthDayMatch[1]);
    const day = Number(monthDayMatch[2]);
    let year = meetingDate.getFullYear();
    const candidate2 = safeDate(year, monthIdx, day);
    if (candidate2 && candidate2 < meetingDate) {
      // If the date already passed this year, assume next year.
      const next = safeDate(year + 1, monthIdx, day);
      if (next) return isoDate(next);
    }
    if (candidate2) return isoDate(candidate2);
  }

  // "by Friday" / "by Mon" — next occurrence of that weekday on/after meeting date
  const weekdayMatch = lower.match(/\b(?:by\s+)?(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/);
  if (weekdayMatch) {
    const target = weekdayIndex(weekdayMatch[1]);
    if (target !== null) {
      const d = nextWeekday(meetingDate, target);
      if (d) return isoDate(d);
    }
  }

  // "tomorrow"
  if (/\btomorrow\b/.test(lower)) {
    const d = addDays(meetingDate, 1);
    return isoDate(d);
  }

  // "today" / "by EOD"
  if (/\btoday\b/.test(lower) || /\beod\b/.test(lower)) {
    return isoDate(meetingDate);
  }

  // "EOW" / "end of week" — Friday of the current week
  if (/\beow\b/.test(lower) || /end\s+of\s+week/.test(lower)) {
    const d = nextWeekday(meetingDate, 5); // Friday
    return isoDate(d);
  }

  // "next week" — Monday of next week
  if (/next\s+week/.test(lower)) {
    const d = nextWeekday(addDays(meetingDate, 7), 1); // Monday next week
    return isoDate(d);
  }

  // "next Monday/Tuesday/..." — the weekday in the following week
  const nextWeekdayMatch = lower.match(/next\s+(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/);
  if (nextWeekdayMatch) {
    const target = weekdayIndex(nextWeekdayMatch[1]);
    if (target !== null) {
      const d = nextWeekday(addDays(meetingDate, 7), target);
      if (d) return isoDate(d);
    }
  }

  // "in N days"
  const inDaysMatch = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDaysMatch) {
    const d = addDays(meetingDate, Number(inDaysMatch[1]));
    return isoDate(d);
  }

  return null;
}

function detectPriority(candidate, dueDate, meetingDate, urgentSignals, deferSignals, nearDeadlineHours) {
  const lower = candidate.toLowerCase();

  const isUrgent = urgentSignals.some((s) => lower.includes(s));
  const isDeferred = deferSignals.some((s) => lower.includes(s));

  if (isUrgent) return "high";

  if (dueDate) {
    const due = parseDate(dueDate);
    if (due) {
      const diffHours = (due.getTime() - meetingDate.getTime()) / (1000 * 60 * 60);
      if (diffHours <= nearDeadlineHours) return "high";
    }
  }

  if (isDeferred) return "low";

  return "medium";
}

function cleanDescription(candidate) {
  // Strip leading "ACTION:" / "Task:" markers and trim.
  let d = candidate.replace(/^(action|task)\s*:\s*/i, "").trim();
  // Collapse whitespace
  d = d.replace(/\s+/g, " ").trim();
  // Truncate overly long descriptions
  if (d.length > 200) d = d.slice(0, 197) + "...";
  return d;
}

function summarizeMeeting(notes) {
  const clean = notes.replace(/\s+/g, " ").trim();
  if (clean.length <= 160) return clean;
  return clean.slice(0, 157) + "...";
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function parseDate(s) {
  if (!s) return null;
  // Accept YYYY-MM-DD (and YYYY-MM-DDTHH:MM:SSZ). Use UTC midnight to avoid TZ drift.
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (!m) return null;
  const d = safeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d;
}

function safeDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  if (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m &&
    dt.getUTCDate() === d
  ) {
    return dt;
  }
  return null;
}

function isoDate(d) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function addDays(d, n) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function nextWeekday(from, targetIdx) {
  // 0=Sun ... 6=Sat. Return the next occurrence of targetIdx on or after `from`.
  // If `from` is already that weekday, return the same day (due "by Friday" on a Friday = today).
  const current = from.getUTCDay();
  const diff = (targetIdx - current + 7) % 7;
  return addDays(from, diff);
}

function weekdayIndex(token) {
  const t = token.slice(0, 3).toLowerCase();
  return WEEKDAY_NAMES.indexOf(t);
}

function monthIndex(token) {
  const t = token.slice(0, 3).toLowerCase();
  return MONTH_NAMES.indexOf(t);
}

function capitalizeName(name) {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// Input parsing utilities
// ---------------------------------------------------------------------------

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    meeting: parseInputValue(process.env.RUNX_INPUT_MEETING),
    priority_policy: parseInputValue(process.env.RUNX_INPUT_PRIORITY_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(name + " must be an object");
  return value;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(64);
}
