import fs from "node:fs";

// ---------------------------------------------------------------------------
// CRM Cleanup — transcript → takeaways → field_updates → gated write_proposal
// Performs NO live CRM write. The write_proposal is gated (advisory only).
// ---------------------------------------------------------------------------

const inputs = readInputs();

const transcript = inputs.transcript;
const crmSchema = inputs.crm_schema;

// ---------------------------------------------------------------------------
// Validate inputs
// ---------------------------------------------------------------------------

if (typeof transcript !== "string" || transcript.trim().length === 0) {
  fail("transcript must be a non-empty string");
}

if (!crmSchema || typeof crmSchema !== "object" || Array.isArray(crmSchema)) {
  fail("crm_schema must be an object with a fields array");
}

if (!Array.isArray(crmSchema.fields)) {
  fail("crm_schema.fields must be an array");
}

if (crmSchema.fields.length === 0) {
  fail("crm_schema.fields must not be empty — at least one field is required");
}

const allowedFields = new Map();
for (const f of crmSchema.fields) {
  if (!f || typeof f !== "object" || !f.name || typeof f.name !== "string") {
    fail("each crm_schema.fields entry must have a non-empty 'name' string");
  }
  allowedFields.set(f.name.toLowerCase(), { name: f.name, type: f.type || "string", options: f.options || null });
}

// ---------------------------------------------------------------------------
// Extract takeaways from the transcript
//
// Strategy: scan the transcript for grounded factual statements using
// pattern-based extraction. Each takeaway records the source quote.
// ---------------------------------------------------------------------------

const takeaways = [];
let tkCounter = 0;

function addTakeaway(text, quote) {
  tkCounter += 1;
  const id = `tk${tkCounter}`;
  takeaways.push({ id, text, quote });
  return id;
}

// Title / role patterns
const titlePatterns = [
  /\b(?:I am|I'm|I am the|I'm the)\s+(?:the\s+)?(VP of [A-Za-z]+|Chief [A-Za-z]+ Officer|CEO|CTO|CFO|COO|CIO|Founder|Co-Founder|President|Director of [A-Za-z]+|Engineering Manager|Product Manager|Head of [A-Za-z]+|Senior [A-Za-z]+ Engineer|[A-Za-z]+ Engineer|Sales [A-Za-z]+|Account [A-Za-z]+)\b/i,
  /\b(?:my title is|my role is)\s+(?:the\s+)?([A-Z][A-Za-z\s]+?)(?:\.|,| at | here|$)/i,
];

// Company patterns — match "from <Company>" / "at <Company>" with Corp/Inc suffixes preferred
const companyPatterns = [
  /\b(?:from|at|here at|with|work(?:s|ing)? (?:at|for))\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3}(?:\s+(?:Corp|Inc|LLC|Ltd|Co|GmbH|Ltd\.))?)\b/g,
  /\b(?:company|org|organization)\s+(?:is\s+)?(?:called|named)?\s*([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3}(?:\s+(?:Corp|Inc|LLC|Ltd|Co))?)\b/i,
];

// Deal value patterns — capture number + optional unit (k/K/thousand/m/M/million)
const dealValuePatterns = [
  /\b(?:budget|budget of|deal|deal of|spend|spending|invest|investing|price|cost|contract value)\s+(?:of\s+)?\$?(\d[\d,]*(?:\.\d+)?)\s*(k|K|thousand|million|m|M)\b/gi,
  /\$(\d[\d,]*(?:\.\d+)?)\s*(k|K|thousand|million|m|M)\b/gi,
  /\b(?:budget|budget of|deal|deal of|spend|spending|invest|investing|price|cost|contract value)\s+(?:of\s+)?\$?(\d[\d,]*(?:\.\d+)?)\s*(?=$|\.|,|for|in)/gi,
];

// Stage patterns
const stagePatterns = [
  /\b(?:move forward|sign|signed|signing|close|closing|closed|won|deal closed|contract signed)\b/i,
  /\b(?:qualified|opportunity|pipeline|negotiation)\b/i,
];

// Expected close date patterns — capture "end of July", "by July 31", ISO dates
const closeDatePatterns = [
  /\b(?:sign by|close by|expected close|close date|deadline)\s+(?:end of\s+)?([A-Za-z]+\s*\d{0,2},?\s*\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]+)/i,
  /\b(?:by end of|by the end of)\s+([A-Za-z]+(?:\s+\d{4})?)/i,
  /\b(?:end of)\s+([A-Za-z]+(?:\s+\d{4})?)/i,
];

const transcriptLower = transcript;

// Extract title/role
for (const pattern of titlePatterns) {
  const match = transcript.match(pattern);
  if (match && match[1]) {
    const title = match[1].trim().replace(/\.$/, "");
    // Find a surrounding quote (sentence containing the match)
    const quote = findContainingSentence(transcript, match[0]);
    addTakeaway(`The contact's title is ${title}.`, quote);
    break;
  }
}

// Extract company — prefer matches with Corp/Inc/Ltd suffix, then longest match
const companyMatches = [];
for (const pattern of companyPatterns) {
  let m;
  const localRe = new RegExp(pattern.source, pattern.flags);
  while ((m = localRe.exec(transcript)) !== null) {
    if (m[1]) {
      let company = m[1].trim().replace(/[.,]$/, "");
      if (company.length >= 2 && !isCommonWord(company) && !isPersonName(company, transcript)) {
        const hasSuffix = /\b(?:Corp|Inc|LLC|Ltd|Co|GmbH)\b/.test(company);
        companyMatches.push({ company, match: m[0], hasSuffix, len: company.length });
      }
    }
  }
}
if (companyMatches.length > 0) {
  // Sort: prefer suffix matches, then longer names
  companyMatches.sort((a, b) => {
    if (a.hasSuffix !== b.hasSuffix) return b.hasSuffix ? 1 : -1;
    return b.len - a.len;
  });
  const best = companyMatches[0];
  const quote = findContainingSentence(transcript, best.match);
  addTakeaway(`The contact's company is ${best.company}.`, quote);
}

// Extract deal value
for (const pattern of dealValuePatterns) {
  const localRe = new RegExp(pattern.source, pattern.flags);
  let m;
  while ((m = localRe.exec(transcript)) !== null) {
    if (m[1]) {
      let value = parseFloat(m[1].replace(/,/g, ""));
      const unit = m[2]; // may be undefined for the third pattern
      if (unit) {
        const u = unit.toLowerCase();
        if (u === "k" || u === "thousand") value *= 1000;
        if (u === "m" || u === "million") value *= 1000000;
      }
      const quote = findContainingSentence(transcript, m[0]);
      addTakeaway(`The deal value is $${value}.`, quote);
      break;
    }
  }
  if (takeaways.some((t) => t.text.includes("deal value"))) break;
}

// Extract stage
for (const pattern of stagePatterns) {
  const match = transcript.match(pattern);
  if (match) {
    let stage = "qualified";
    if (/\b(?:sign|signed|signing|close|closing|closed|won)\b/i.test(match[0])) {
      stage = "closed";
    }
    const quote = findContainingSentence(transcript, match[0]);
    addTakeaway(`The deal stage is ${stage}.`, quote);
    break;
  }
}

// Extract expected close date
for (const pattern of closeDatePatterns) {
  const match = transcript.match(pattern);
  if (match && match[1]) {
    const dateStr = match[1].trim();
    const quote = findContainingSentence(transcript, match[0]);
    addTakeaway(`The expected close date is ${dateStr}.`, quote);
    break;
  }
}

// ---------------------------------------------------------------------------
// Map takeaways to allowed CRM fields
// ---------------------------------------------------------------------------

const fieldUpdates = [];

// Field name synonyms for mapping takeaways to CRM fields
const fieldSynonyms = {
  title: ["title", "role", "position", "jobtitle", "job_title"],
  company: ["company", "org", "organization", "account", "employer"],
  deal_value: ["deal_value", "dealvalue", "amount", "value", "budget", "opportunity_amount"],
  stage: ["stage", "deal_stage", "pipeline_stage", "status"],
  expected_close_date: ["expected_close_date", "close_date", "expected_close", "closeby", "deadline"],
};

for (const tk of takeaways) {
  const textLower = tk.text.toLowerCase();
  let mapped = false;

  for (const [canonical, synonyms] of Object.entries(fieldSynonyms)) {
    if (mapped) break;
    // Check if any allowed field matches this canonical field
    const fieldDef = allowedFields.get(canonical.toLowerCase());
    if (!fieldDef) {
      // Check synonyms against allowed fields
      for (const syn of synonyms) {
        const fd = allowedFields.get(syn.toLowerCase());
        if (fd) {
          if (tryMapField(tk, textLower, fd, canonical)) {
            mapped = true;
            break;
          }
        }
      }
      continue;
    }
    if (tryMapField(tk, textLower, fieldDef, canonical)) {
      mapped = true;
    }
  }
}

function tryMapField(tk, textLower, fieldDef, canonical) {
  // Only map if the takeaway text relates to this canonical field
  if (canonical === "title" && /title|role|vp of|chief|officer|director|manager|engineer|founder|president|head of/.test(textLower)) {
    const value = extractValueFromTakeaway(tk.text, "title");
    if (value) {
      fieldUpdates.push({
        field: fieldDef.name,
        value: coerceType(value, fieldDef),
        takeaway_id: tk.id,
        source_quote: tk.quote,
      });
      return true;
    }
  }
  if (canonical === "company" && /company|corp|inc|llc|from|at/.test(textLower)) {
    const value = extractValueFromTakeaway(tk.text, "company");
    if (value) {
      fieldUpdates.push({
        field: fieldDef.name,
        value: coerceType(value, fieldDef),
        takeaway_id: tk.id,
        source_quote: tk.quote,
      });
      return true;
    }
  }
  if (canonical === "deal_value" && /deal value|budget|amount|\$/.test(textLower)) {
    const value = extractValueFromTakeaway(tk.text, "deal_value");
    if (value !== null) {
      fieldUpdates.push({
        field: fieldDef.name,
        value: coerceType(value, fieldDef),
        takeaway_id: tk.id,
        source_quote: tk.quote,
      });
      return true;
    }
  }
  if (canonical === "stage" && /stage|qualified|closed|pipeline/.test(textLower)) {
    const value = extractValueFromTakeaway(tk.text, "stage");
    if (value) {
      const coerced = coerceType(value, fieldDef);
      // For enum, validate against options
      if (fieldDef.type === "enum" && fieldDef.options && !fieldDef.options.includes(coerced)) {
        // Pick closest valid option
        if (fieldDef.options.includes("qualified")) {
          fieldUpdates.push({
            field: fieldDef.name,
            value: "qualified",
            takeaway_id: tk.id,
            source_quote: tk.quote,
          });
          return true;
        }
      } else {
        fieldUpdates.push({
          field: fieldDef.name,
          value: coerced,
          takeaway_id: tk.id,
          source_quote: tk.quote,
        });
        return true;
      }
    }
  }
  if (canonical === "expected_close_date" && /close date|expected close|deadline|by end of|sign by|close by/.test(textLower)) {
    const value = extractValueFromTakeaway(tk.text, "expected_close_date");
    if (value) {
      fieldUpdates.push({
        field: fieldDef.name,
        value: coerceType(value, fieldDef),
        takeaway_id: tk.id,
        source_quote: tk.quote,
      });
      return true;
    }
  }
  return false;
}

function extractValueFromTakeaway(text, canonical) {
  if (canonical === "title") {
    const m = text.match(/title is (.+?)\./i);
    return m ? m[1].trim() : null;
  }
  if (canonical === "company") {
    const m = text.match(/company is (.+?)\./i);
    return m ? m[1].trim() : null;
  }
  if (canonical === "deal_value") {
    const m = text.match(/\$(\d[\d,]*(?:\.\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  }
  if (canonical === "stage") {
    const m = text.match(/stage is (\w+)/i);
    return m ? m[1].toLowerCase() : null;
  }
  if (canonical === "expected_close_date") {
    const m = text.match(/close date is (.+?)\./i);
    return m ? m[1].trim() : null;
  }
  return null;
}

function coerceType(value, fieldDef) {
  if (fieldDef.type === "number") {
    const n = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? value : n;
  }
  if (fieldDef.type === "boolean") {
    return Boolean(value);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Build gated write_proposal
// ---------------------------------------------------------------------------

const writeProposal = {
  gate: "proposed",
  performed_write: false,
  field_updates: fieldUpdates.map((fu) => ({
    field: fu.field,
    value: fu.value,
    takeaway_id: fu.takeaway_id,
  })),
  note: "Gated proposal — no live CRM write performed. Review before applying.",
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = {
  takeaways,
  field_updates: fieldUpdates,
  write_proposal: writeProposal,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findContainingSentence(text, matchStr) {
  const idx = text.indexOf(matchStr);
  if (idx === -1) return matchStr;
  // Find sentence boundaries
  let start = text.lastIndexOf(".", idx);
  start = start === -1 ? 0 : start + 1;
  let end = text.indexOf(".", idx + matchStr.length);
  end = end === -1 ? text.length : end + 1;
  let sentence = text.slice(start, end).trim();
  if (sentence.length === 0) sentence = matchStr;
  // Truncate very long sentences
  if (sentence.length > 200) sentence = sentence.slice(0, 197) + "...";
  return sentence;
}

function isCommonWord(word) {
  const common = ["the", "this", "that", "with", "from", "about", "have", "they", "their", "there", "here", "what", "when", "where", "which", "some", "more", "than", "then", "them", "also", "very", "just", "only", "like", "such"];
  return common.includes(word.toLowerCase());
}

// Heuristic: detect if a matched "company" string is actually a person's name
// (e.g. "Sarah Chen"). Checks if it appears right after "Call with <Name>" or
// is preceded by "said" / "Mr" / "Ms" / "Mrs" patterns.
function isPersonName(company, transcript) {
  // Two-word capitalized strings where the first word is a common first name
  // and the pattern appears in "Call with X" / "X said" / "X called"
  const namePattern = new RegExp(`\\b(?:Call with|Spoke with|Talked to|Mr\\.?|Ms\\.?|Mrs\\.?)\\s+${escapeRegex(company)}\\b`, "i");
  if (namePattern.test(transcript)) return true;
  // Check "X said" / "X called" / "X mentioned"
  const saidPattern = new RegExp(`\\b${escapeRegex(company)}\\s+(?:said|called|mentioned|stated|noted|asked|wants|expects)\\b`, "i");
  if (saidPattern.test(transcript)) return true;
  // If it's exactly two words and both look like names (no Corp/Inc suffix), check common first names
  const parts = company.split(/\s+/);
  if (parts.length === 2 && !/\b(?:Corp|Inc|LLC|Ltd|Co|GmbH)\b/.test(company)) {
    // Check if "X Y from Z" pattern — if company appears before "from", it's a person
    const fromPattern = new RegExp(`\\b${escapeRegex(company)}\\s+from\\b`, "i");
    if (fromPattern.test(transcript)) return true;
  }
  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    transcript: process.env.RUNX_INPUT_TRANSCRIPT,
    crm_schema: parseInputValue(process.env.RUNX_INPUT_CRM_SCHEMA),
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
