import fs from "node:fs";

const input = readInputs();
const refs = Array.isArray(input.receipt_refs) ? input.receipt_refs.map(String) : [];
const summaries = Array.isArray(input.receipt_summaries) ? input.receipt_summaries : [];
const verifyResults = Array.isArray(input.verify_results) ? input.verify_results : [];
const artifacts = Array.isArray(input.artifact_links) ? input.artifact_links : [];

if (refs.length === 0 && summaries.length === 0) {
  emit(packet("needs_input", [], [], ["Provide receipt_refs or receipt_summaries."], [{ action: "provide_receipt_evidence" }], []));
}

const malformed = refs.filter((ref) => !/^runx:receipt:[A-Za-z0-9_.:-]+$/.test(ref));
if (malformed.length > 0) {
  emit(packet("refused", [], [], malformed.map((ref) => `Malformed receipt ref: ${redact(ref)}`), [{ action: "provide_valid_receipt_ref" }], []));
}

const verified = [];
const inferred = [];
const missing = [];
const actions = [];
const redactions = [];

for (const ref of refs) {
  const check = verifyResults.find((entry) => String(entry.receipt_ref || entry.ref) === ref);
  if (check && (check.verdict === "valid" || check.status === "sealed" || check.ok === true)) {
    verified.push({ receipt_ref: ref, fact: "receipt verification was supplied as valid", source: "verify_results" });
  } else {
    missing.push(`No valid runx verify output supplied for ${ref}.`);
    actions.push({ action: "run_verify", receipt_ref: ref, command: `runx verify --receipt ${ref} --json` });
  }
}

for (const summary of summaries) {
  const raw = JSON.stringify(summary);
  const clean = redact(raw);
  if (raw !== clean) redactions.push({ field: "receipt_summary", reason: "private or secret-like material redacted" });
  verified.push({ receipt_ref: text(summary.receipt_ref) || "inline_summary", fact: "sanitized receipt summary provided", source: "receipt_summaries" });
  if (Array.isArray(summary.effects)) inferred.push({ receipt_ref: text(summary.receipt_ref) || "inline_summary", fact: `${summary.effects.length} effect(s) described by summary`, confidence: "medium" });
  if (!summary.authority) missing.push(`Authority evidence missing for ${text(summary.receipt_ref) || "inline_summary"}.`);
}

for (const artifact of artifacts) {
  verified.push({ receipt_ref: "artifact", fact: `artifact link supplied: ${redact(text(artifact.url) || text(artifact) || "artifact")}`, source: "artifact_links" });
}

emit(packet(missing.length ? "needs_more_evidence" : "ready", verified, inferred, missing, actions.length ? actions : [{ action: "review_bundle" }], redactions));

function packet(status, verifiedFacts, inferredFacts, missingEvidence, reviewerActions, redactionList) {
  return {
    status,
    verified_facts: verifiedFacts,
    inferred_facts: inferredFacts,
    missing_evidence: missingEvidence,
    reviewer_actions: reviewerActions,
    redactions: redactionList,
    evidence: { receipt_count: refs.length + summaries.length, verify_verdict: missingEvidence.length ? "incomplete" : "valid_or_supplied", read_only: true },
  };
}
function readInputs() { if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")); if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON); return {}; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function redact(value) { return String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]").replace(/(sk|ghp|xoxb|token)[A-Za-z0-9_-]{8,}/gi, "[redacted-secret]"); }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }

