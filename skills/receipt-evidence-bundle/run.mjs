import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "runx.receipt_evidence_bundle.v1";
const inputs = readInputs();
const skillRoot = process.cwd();

const receiptRefs = normalizeReceiptRefs(inputs);
const verificationRecords = normalizeVerificationRecords(inputs.verification_json);
const artifacts = normalizeArtifacts(inputs.artifact_links);
const bundle = buildBundle({
  receiptRefs,
  verificationRecords,
  artifacts,
  reviewerContext: stringValue(inputs.reviewer_context) || "Receipt evidence review",
});
const report = renderReport(bundle);

writeArtifacts(inputs.output_dir, bundle, report, skillRoot);
process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizeReceiptRefs(rawInputs) {
  const refs = [];
  if (typeof rawInputs.receipt_ref === "string" && rawInputs.receipt_ref.trim()) {
    refs.push(rawInputs.receipt_ref.trim());
  }
  const many = parseMaybeJson(rawInputs.receipt_refs);
  if (Array.isArray(many)) {
    for (const ref of many) {
      if (typeof ref === "string" && ref.trim()) refs.push(ref.trim());
    }
  }
  return [...new Set(refs)];
}

function normalizeVerificationRecords(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  if (!parsed) return [];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((record) => record && typeof record === "object")
    .map((record) => ({
      receipt_ref: stringValue(record.receipt_ref) || stringValue(record.receipt_id) || stringValue(record.id),
      verdict: normalizeVerdict(record.verdict || record.status || record.decision),
      signature_valid: booleanValue(record.signature_valid ?? record.signatureValid),
      receipt_sha256: stringValue(record.receipt_sha256) || stringValue(record.sha256) || stringValue(record.digest),
      raw_keys: Object.keys(record).sort(),
    }));
}

function normalizeArtifacts(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  if (!parsed) return [];
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((record) => record && typeof record === "object")
    .map((record, index) => sanitizeArtifact(record, index));
}

function sanitizeArtifact(record, index) {
  const publicUrl = stringValue(record.url) || stringValue(record.href) || "";
  const explicitDigest = stringValue(record.sha256) || stringValue(record.digest) || "";
  const privateFlag = record.private === true || record.public === false;
  const redactedFields = [];
  const sanitized = {
    kind: stringValue(record.kind) || `artifact-${index + 1}`,
    url: publicUrl,
    digest: explicitDigest,
    public: !privateFlag,
    summary: stringValue(record.summary),
    redacted_fields: redactedFields,
  };

  for (const key of Object.keys(record).sort()) {
    if (/token|secret|password|cookie|body|payload/i.test(key)) {
      redactedFields.push(key);
    }
  }
  if (!sanitized.digest && sanitized.url) {
    sanitized.digest = `sha256:${sha256(sanitized.url)}`;
  }
  if (privateFlag) {
    sanitized.url = "";
  }
  return sanitized;
}

function buildBundle({ receiptRefs, verificationRecords, artifacts, reviewerContext }) {
  const malformedRefs = receiptRefs.filter((ref) => !ref.startsWith("runx:receipt:"));
  const redactions = artifactRedactions(artifacts);

  if (receiptRefs.length === 0) {
    return baseBundle({
      decision: "needs_more_evidence",
      reviewerContext,
      receiptRefs,
      artifacts,
      redactions,
      missingEvidence: [{
        item: "receipt_ref",
        reason: "At least one runx receipt reference is required before a reviewer can approve the work.",
      }],
      reviewerActions: [{
        action: "provide_receipt_ref",
        reason: "Run or locate the governed run and supply its runx:receipt reference.",
      }],
    });
  }

  if (malformedRefs.length > 0) {
    return baseBundle({
      decision: "refused",
      reviewerContext,
      receiptRefs,
      artifacts,
      redactions,
      missingEvidence: malformedRefs.map((ref) => ({
        item: ref,
        reason: "Receipt references must start with runx:receipt:.",
      })),
      reviewerActions: [{
        action: "replace_malformed_receipt_refs",
        reason: "The bundle refuses arbitrary strings so reviewers do not approve unverifiable evidence.",
      }],
    });
  }

  const verifiedFacts = [];
  const inferredFacts = [];
  const missingEvidence = [];
  const reviewerActions = [];
  let failedVerification = false;

  for (const ref of receiptRefs) {
    const record = findVerification(ref, verificationRecords);
    if (!record) {
      missingEvidence.push({
        item: `verification_json:${ref}`,
        reason: "No runx verify JSON record was supplied for this receipt.",
      });
      reviewerActions.push({
        action: `runx verify --receipt <receipt for ${ref}> --json`,
        reason: "A reviewer needs a verify verdict before approving payout or merge.",
      });
      continue;
    }

    verifiedFacts.push({
      receipt_ref: ref,
      fact: `Verification verdict is ${record.verdict || "unknown"}.`,
      evidence: `verification_json keys: ${record.raw_keys.join(", ")}`,
    });
    if (record.signature_valid !== undefined) {
      verifiedFacts.push({
        receipt_ref: ref,
        fact: `Signature validity is ${record.signature_valid}.`,
        evidence: "verification_json.signature_valid",
      });
    }
    if (record.receipt_sha256) {
      verifiedFacts.push({
        receipt_ref: ref,
        fact: `Receipt digest is ${record.receipt_sha256}.`,
        evidence: "verification_json receipt digest field",
      });
    }
    if (!["pass", "sealed", "valid", "verified"].includes(record.verdict)) {
      failedVerification = true;
      reviewerActions.push({
        action: "resolve_failed_verification",
        reason: `${ref} did not report a passing verify verdict.`,
      });
    }
  }

  for (const artifact of artifacts) {
    const basis = artifact.digest || artifact.url || artifact.kind;
    inferredFacts.push({
      fact: `${artifact.kind} artifact is ${artifact.public ? "public" : "private/redacted"}.`,
      basis,
    });
  }

  const decision = missingEvidence.length > 0
    ? "needs_more_evidence"
    : failedVerification
      ? "needs_review"
      : "ready";

  return baseBundle({
    decision,
    reviewerContext,
    receiptRefs,
    artifacts,
    redactions,
    verifiedFacts,
    inferredFacts,
    missingEvidence,
    reviewerActions: reviewerActions.length > 0
      ? reviewerActions
      : [{
        action: "spot_check_artifacts_against_receipt",
        reason: "Receipt verification passed; final review should compare artifact URLs and digests with the submitted delivery.",
      }],
  });
}

function baseBundle({
  decision,
  reviewerContext,
  receiptRefs,
  artifacts,
  redactions,
  verifiedFacts = [],
  inferredFacts = [],
  missingEvidence = [],
  reviewerActions = [],
}) {
  return {
    schema: SCHEMA,
    decision,
    reviewer_context: reviewerContext,
    receipt_refs: receiptRefs,
    verified_facts: verifiedFacts,
    inferred_facts: inferredFacts,
    missing_evidence: missingEvidence,
    reviewer_actions: reviewerActions,
    redactions,
    artifacts,
    summary: {
      receipts_total: receiptRefs.length,
      receipts_verified: verifiedFacts.filter((fact) => /verdict is (pass|sealed|valid|verified)/.test(fact.fact)).length,
      artifacts_total: artifacts.length,
      redactions_total: redactions.length,
    },
  };
}

function artifactRedactions(artifacts) {
  const redactions = [];
  for (const artifact of artifacts) {
    if (!artifact.public) {
      redactions.push({
        field: `${artifact.kind}.url`,
        reason: "Artifact is marked private; the reviewer packet keeps only digest/summary metadata.",
      });
    }
    for (const field of artifact.redacted_fields) {
      redactions.push({
        field: `${artifact.kind}.${field}`,
        reason: "Secret-bearing or private payload field was not copied into the bundle.",
      });
    }
  }
  return redactions;
}

function findVerification(ref, records) {
  return records.find((record) =>
    record.receipt_ref === ref
    || (record.receipt_ref && ref.endsWith(record.receipt_ref))
    || (record.receipt_sha256 && ref.includes(record.receipt_sha256)));
}

function renderReport(bundle) {
  const lines = [
    `# Receipt Evidence Bundle`,
    "",
    `Decision: ${bundle.decision}`,
    `Review context: ${bundle.reviewer_context}`,
    `Receipts: ${bundle.receipt_refs.length}`,
    `Artifacts: ${bundle.artifacts.length}`,
    "",
    "## Verified Facts",
    ...bulletFacts(bundle.verified_facts, "fact", "evidence"),
    "",
    "## Inferred Facts",
    ...bulletFacts(bundle.inferred_facts, "fact", "basis"),
    "",
    "## Missing Evidence",
    ...bulletFacts(bundle.missing_evidence, "item", "reason"),
    "",
    "## Reviewer Actions",
    ...bulletFacts(bundle.reviewer_actions, "action", "reason"),
    "",
    "## Redactions",
    ...bulletFacts(bundle.redactions, "field", "reason"),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function bulletFacts(entries, primary, secondary) {
  if (!entries.length) return ["- None."];
  return entries.map((entry) => `- ${entry[primary]}: ${entry[secondary]}`);
}

function writeArtifacts(outputDir, evidence, report, root) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") return;
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function normalizeVerdict(value) {
  const text = stringValue(value).toLowerCase();
  if (!text) return "";
  if (["ok", "success", "passed", "pass"].includes(text)) return "pass";
  if (["sealed", "valid", "verified", "failed", "fail", "error"].includes(text)) return text;
  return text;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) {
    return value.toLowerCase() === "true";
  }
  return undefined;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
