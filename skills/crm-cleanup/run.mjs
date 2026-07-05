import fs from "node:fs";

// ---------------------------------------------------------------------------
// Read inputs
// ---------------------------------------------------------------------------

const inputs = readInputs();

const contactsRaw = inputs.contacts;
const policy = inputs.cleanup_policy && typeof inputs.cleanup_policy === "object"
  ? inputs.cleanup_policy
  : {};

// ---------------------------------------------------------------------------
// Validate contacts
// ---------------------------------------------------------------------------

if (!Array.isArray(contactsRaw)) {
  fail("contacts must be an array of contact objects");
}
if (contactsRaw.length === 0) {
  fail("contacts must not be empty — at least one contact is required to produce a cleanup report");
}

const contacts = contactsRaw.map((c, i) => {
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    fail(`contacts[${i}] must be an object`);
  }
  if (!c.id || !stringValue(c.id)) {
    fail(`contacts[${i}] is missing a required non-empty 'id' field`);
  }
  return c;
});

// ---------------------------------------------------------------------------
// Policy defaults
// ---------------------------------------------------------------------------

const stalenessDays = typeof policy.staleness_days === "number" && policy.staleness_days > 0
  ? policy.staleness_days
  : 365;

if (policy.staleness_days !== undefined && (typeof policy.staleness_days !== "number" || policy.staleness_days <= 0)) {
  fail("cleanup_policy.staleness_days must be a positive number");
}

const requiredFields = Array.isArray(policy.required_fields)
  ? policy.required_fields
  : ["name", "email", "company"];

if (policy.required_fields !== undefined && !requiredFields.every((f) => typeof f === "string")) {
  fail("cleanup_policy.required_fields must be an array of strings");
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

const now = new Date();
const stalenessMs = stalenessDays * 24 * 60 * 60 * 1000;

const normalized = contacts.map((c) => ({
  id: String(c.id),
  name: stringValue(c.name),
  email: normalizeEmail(c.email),
  phone: normalizePhone(c.phone),
  company: stringValue(c.company),
  lastContactedAt: stringValue(c.last_contacted_at),
  raw: c,
}));

// ---------------------------------------------------------------------------
// Detect duplicates
// ---------------------------------------------------------------------------

const duplicates = [];
const seenContactIds = new Set();

// Group by normalized email
const byEmail = groupBy(normalized, (c) => c.email, "email");
// Group by normalized phone
const byPhone = groupBy(normalized, (c) => c.phone, "phone");
// Group by fuzzy name+company key
const byNameCompany = groupBy(
  normalized,
  (c) => (c.name && c.company ? `${c.name}|${c.company}` : null),
  "name+company"
);

for (const group of [byEmail, byPhone, byNameCompany]) {
  for (const g of group) {
    if (g.contactIds.length > 1) {
      const key = `${g.contactIds.sort().join(",")}:${g.matchKey}:${g.matchValue}`;
      if (seenContactIds.has(key)) continue;
      seenContactIds.add(key);
      duplicates.push({
        match_key: g.matchKey,
        match_value: g.matchValue,
        contact_ids: g.contactIds,
        suggested_action: "merge_suggestion",
        note: "Possible duplicate based on matching " + g.matchKey + ". Review before merging.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Detect missing fields
// ---------------------------------------------------------------------------

const missingFields = [];

for (const c of normalized) {
  const missing = requiredFields.filter((f) => {
    const v = c.raw[f];
    return !stringValue(v);
  });
  if (missing.length > 0) {
    missingFields.push({
      contact_id: c.id,
      missing,
      suggested_action: "fill_missing_field",
      note: "Contact is missing required field(s). No data modified.",
    });
  }
}

// ---------------------------------------------------------------------------
// Detect stale entries
// ---------------------------------------------------------------------------

const staleEntries = [];

for (const c of normalized) {
  if (!c.lastContactedAt) {
    staleEntries.push({
      contact_id: c.id,
      last_contacted_at: null,
      days_since_contact: null,
      reason: "no_contact_date",
      suggested_action: "archive_stale",
      note: "Contact has no last_contacted_at. Consider archiving after review.",
    });
    continue;
  }

  let contactedDate;
  try {
    contactedDate = new Date(c.lastContactedAt);
  } catch {
    contactedDate = null;
  }

  if (!contactedDate || isNaN(contactedDate.getTime())) {
    staleEntries.push({
      contact_id: c.id,
      last_contacted_at: c.lastContactedAt,
      days_since_contact: null,
      reason: "unparseable_date",
      suggested_action: "archive_stale",
      note: "Contact has an unparseable last_contacted_at. Review and update the date.",
    });
    continue;
  }

  const diffMs = now.getTime() - contactedDate.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMs > stalenessMs) {
    staleEntries.push({
      contact_id: c.id,
      last_contacted_at: c.lastContactedAt,
      days_since_contact: diffDays,
      reason: "exceeds_threshold",
      suggested_action: "archive_stale",
      note: "Contact is stale (last contacted " + diffDays + " days ago, threshold " + stalenessDays + " days). Consider archiving after review.",
    });
  }
}

// ---------------------------------------------------------------------------
// Build actions list (advisory only)
// ---------------------------------------------------------------------------

const actions = [];

for (const d of duplicates) {
  actions.push({
    type: "merge_suggestion",
    contact_ids: d.contact_ids,
    priority: "high",
  });
}

for (const m of missingFields) {
  actions.push({
    type: "fill_missing_field",
    contact_ids: [m.contact_id],
    priority: "medium",
  });
}

for (const s of staleEntries) {
  actions.push({
    type: "archive_stale",
    contact_ids: [s.contact_id],
    priority: "low",
  });
}

// ---------------------------------------------------------------------------
// Summary and output
// ---------------------------------------------------------------------------

const duplicateContactIds = new Set();
for (const d of duplicates) {
  for (const id of d.contact_ids) duplicateContactIds.add(id);
}

const result = {
  summary: {
    total_contacts: normalized.length,
    duplicate_sets: duplicates.length,
    duplicates_count: duplicateContactIds.size,
    missing_fields_count: missingFields.length,
    stale_count: staleEntries.length,
    total_issues: duplicates.length + missingFields.length + staleEntries.length,
  },
  duplicates,
  missing_fields: missingFields,
  stale_entries: staleEntries,
  actions,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy(items, keyFn, matchKey) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { matchKey, matchValue: key, contactIds: [], seen: new Set() });
    }
    const entry = map.get(key);
    if (!entry.seen.has(item.id)) {
      entry.seen.add(item.id);
      entry.contactIds.push(item.id);
    }
  }
  return Array.from(map.values());
}

function normalizeEmail(email) {
  if (!email) return null;
  const s = String(email).toLowerCase().trim();
  return s.length > 0 ? s : null;
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, "");
  // Normalize by stripping leading country code "1" for 11-digit US numbers
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return normalized.length >= 7 ? normalized : null;
}

function stringValue(value) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && !isNaN(value)) return String(value);
  return null;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    contacts: parseInputValue(process.env.RUNX_INPUT_CONTACTS),
    cleanup_policy: parseInputValue(process.env.RUNX_INPUT_CLEANUP_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(64);
}
