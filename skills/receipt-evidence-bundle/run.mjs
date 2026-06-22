import fs from "node:fs";

const inputs = readInputs();
const receiptRefs = normalizeReceiptRefs(inputs.receipt_refs);
const verificationResults = normalizeVerificationResults(inputs.verification_results);
const redactionTerms = normalizeRedactionTerms(inputs.redaction_terms);
const redactions = [];

for (const receiptRef of receiptRefs) {
  if (!isReceiptRef(receiptRef)) fail(`malformed receipt reference: ${receiptRef}`);
}

const verifiedFacts = receiptRefs.map((receiptRef) => {
  const verification = findVerification(verificationResults, receiptRef);
  if (!verification) fail(`missing verification result for ${receiptRef}`);
  if (!isValidVerification(verification)) fail(`receipt is not verified: ${receiptRef}`);

  const receipt = receiptBody(verification);
  if (!receipt || receipt.schema !== "runx.receipt.v1") {
    fail(`verified result for ${receiptRef} does not contain schema runx.receipt.v1`);
  }

  const sanitizedReceipt = sanitize(receipt, "receipt", redactions, redactionTerms);
  return {
    receipt_ref: receiptRef,
    verify_verdict: "valid",
    receipt_id: stringValue(sanitizedReceipt.id)
      ?? stringValue(sanitizedReceipt.receipt_id)
      ?? receiptRef,
    schema: sanitizedReceipt.schema,
    state: stringValue(sanitizedReceipt.state),
    disposition: stringValue(sanitizedReceipt.disposition),
    reason_code: stringValue(sanitizedReceipt.reason_code),
    lineage: lineageFrom(sanitizedReceipt),
    authority_evidence: authorityFrom(sanitizedReceipt),
  };
});

const sanitizedArtifacts = sanitize(
  normalizeArtifactLinks(inputs.artifact_links),
  "artifact_links",
  redactions,
  redactionTerms,
);
const inferredFacts = inferLineage(verifiedFacts);
const missingEvidence = findMissingEvidence(verifiedFacts, sanitizedArtifacts);
const reviewerActions = buildReviewerActions(receiptRefs, sanitizedArtifacts);

const result = {
  summary: `Verified ${verifiedFacts.length} runx receipt${verifiedFacts.length === 1 ? "" : "s"} and prepared a reviewer-safe evidence bundle with explicit lineage, authority, gaps, actions, and redaction notes.`,
  verdict: "verified",
  receipt_count: verifiedFacts.length,
  verified_facts: verifiedFacts,
  inferred_facts: inferredFacts,
  missing_evidence: missingEvidence,
  reviewer_actions: reviewerActions,
  redactions: uniqueRedactions(redactions),
  artifact_links: sanitizedArtifacts,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {
    receipt_refs: parseInputValue(process.env.RUNX_INPUT_RECEIPT_REFS),
    verification_results: parseInputValue(process.env.RUNX_INPUT_VERIFICATION_RESULTS),
    artifact_links: parseInputValue(process.env.RUNX_INPUT_ARTIFACT_LINKS),
    redaction_terms: parseInputValue(process.env.RUNX_INPUT_REDACTION_TERMS),
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

function normalizeReceiptRefs(value) {
  const values = Array.isArray(value) ? value : [value];
  const refs = values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (refs.length === 0) fail("receipt_refs must contain at least one receipt reference");
  if (new Set(refs).size !== refs.length) fail("receipt_refs must not contain duplicates");
  return refs;
}

function normalizeVerificationResults(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([receiptRef, result]) => ({
      receipt_ref: receiptRef,
      ...(result && typeof result === "object" ? result : { verdict: result }),
    }));
  }
  fail("verification_results must be an array or object");
}

function normalizeArtifactLinks(value) {
  if (value === undefined || value === null) return {};
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return value;
  fail("artifact_links must be an array or object");
}

function normalizeRedactionTerms(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item) => typeof item === "string" && item.length >= 4);
}

function isReceiptRef(value) {
  return /^runx:receipt:[A-Za-z0-9._:-]+$/.test(value) || /^sha256:[a-fA-F0-9]{64}$/.test(value);
}

function findVerification(results, receiptRef) {
  return results.find((item) => {
    if (!item || typeof item !== "object") return false;
    return [item.receipt_ref, item.ref, item.id, item.receipt?.id, item.receipt?.receipt_id]
      .some((candidate) => candidate === receiptRef);
  });
}

function isValidVerification(value) {
  return value.valid === true
    || value.verdict === "valid"
    || value.status === "valid"
    || value.result?.valid === true
    || value.result?.verdict === "valid";
}

function receiptBody(value) {
  return value.receipt ?? value.result?.receipt ?? value.output?.receipt ?? null;
}

function lineageFrom(receipt) {
  const parentReceiptId = stringValue(receipt.parent_receipt_id)
    ?? stringValue(receipt.parent_id)
    ?? stringValue(receipt.lineage?.parent_receipt_id);
  const rootReceiptId = stringValue(receipt.root_receipt_id)
    ?? stringValue(receipt.lineage?.root_receipt_id);
  return {
    parent_receipt_id: parentReceiptId,
    root_receipt_id: rootReceiptId,
  };
}

function authorityFrom(receipt) {
  const authority = receipt.authority && typeof receipt.authority === "object" ? receipt.authority : {};
  const admission = receipt.scope_admission && typeof receipt.scope_admission === "object"
    ? receipt.scope_admission
    : {};
  return {
    kid: stringValue(authority.kid) ?? stringValue(receipt.kid),
    grant_digest: stringValue(authority.grant_digest) ?? stringValue(receipt.grant_digest),
    admitted_scopes: stringArray(authority.scopes ?? admission.admitted ?? receipt.admitted_scopes),
  };
}

function inferLineage(facts) {
  const ids = new Map(facts.map((fact) => [fact.receipt_id, fact.receipt_ref]));
  const inferred = [];
  for (const fact of facts) {
    const parentId = fact.lineage.parent_receipt_id;
    if (parentId && ids.has(parentId)) {
      inferred.push({
        inference: "parent_child_link",
        child_receipt_ref: fact.receipt_ref,
        parent_receipt_ref: ids.get(parentId),
        basis: "The verified child receipt names the verified parent receipt id.",
      });
    }
  }
  if (inferred.length === 0) {
    inferred.push({
      inference: "no_supplied_cross_receipt_lineage",
      basis: "No verified receipt names another supplied receipt as its parent; ordering is not inferred.",
    });
  }
  return inferred;
}

function findMissingEvidence(facts, artifactLinks) {
  const missing = [];
  for (const fact of facts) {
    if (!fact.state) missing.push(`${fact.receipt_ref}: receipt state is absent`);
    if (!fact.authority_evidence.kid) missing.push(`${fact.receipt_ref}: authority key id is absent`);
    if (!fact.authority_evidence.grant_digest && fact.authority_evidence.admitted_scopes.length === 0) {
      missing.push(`${fact.receipt_ref}: grant digest and admitted scopes are absent`);
    }
  }
  if ((Array.isArray(artifactLinks) && artifactLinks.length === 0)
    || (!Array.isArray(artifactLinks) && Object.keys(artifactLinks).length === 0)) {
    missing.push("No optional public artifact links were supplied.");
  }
  return missing;
}

function buildReviewerActions(receiptRefs, artifactLinks) {
  const actions = receiptRefs.map((receiptRef) => ({
    action: "replay_receipt_verification",
    receipt_ref: receiptRef,
    command: `runx verify --receipt <file-for-${receiptRef}> --json`,
  }));
  const entries = Array.isArray(artifactLinks) ? artifactLinks.entries() : Object.entries(artifactLinks);
  for (const [name, url] of entries) {
    if (typeof url === "string") actions.push({ action: "inspect_public_artifact", name: String(name), url });
  }
  return actions;
}

function sanitize(value, path, redactions, redactionTerms) {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitize(item, `${path}[${index}]`, redactions, redactionTerms));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (isSensitiveKey(key)) {
        redactions.push({ path: itemPath, reason: "sensitive_key", value_removed: true });
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitize(item, itemPath, redactions, redactionTerms);
      }
    }
    return result;
  }
  if (typeof value !== "string") return value;

  let sanitized = value;
  const patterns = [
    /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
    /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
  ];
  for (const pattern of patterns) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
      redactions.push({ path, reason: "secret_pattern", value_removed: true });
    }
    pattern.lastIndex = 0;
  }
  for (const term of redactionTerms) {
    if (sanitized.toLowerCase().includes(term.toLowerCase())) {
      sanitized = replaceLiteralInsensitive(sanitized, term, "[REDACTED]");
      redactions.push({ path, reason: "caller_redaction_term", value_removed: true });
    }
  }
  return sanitized;
}

function isSensitiveKey(key) {
  return /(password|secret|token|authorization|cookie|private[_-]?key|seed[_-]?phrase|credential)/i.test(key);
}

function replaceLiteralInsensitive(value, term, replacement) {
  return value.replace(new RegExp(escapeRegExp(term), "gi"), replacement);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueRedactions(redactions) {
  const seen = new Set();
  return redactions.filter((item) => {
    const key = `${item.path}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

