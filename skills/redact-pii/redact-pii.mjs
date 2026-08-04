const DEFAULT_CLASSES = [
  "name",
  "email",
  "phone",
  "postal_address",
  "government_id",
  "tax_id",
  "payment_card",
  "account_id",
  "record_id",
  "precise_geolocation",
  "date_of_birth",
];
const REASON_CODES = ["none", "ambiguous_semantics", "scrubbing_destroys_meaning", "policy_block", "insufficient_context"];

export function scrubRedaction(inputs) {
  const content = typeof inputs.content === "string" ? inputs.content : "";
  const mode = enumValue(optionalString(inputs.mode) || "redact", ["redact", "tokenize", "block"], "mode");
  const locale = optionalString(inputs.locale) || "und";
  const classes = policyClasses(inputs.classes);
  const draft = record(inputs.redaction_draft);

  let decision = enumValue(draft.decision, ["ready", "needs_review", "blocked"], "decision");
  let detections = [];
  let residual = residualRisk(draft.residual_risk);
  let redactedContent = "";
  let findings = [];

  try {
    detections = parseDetections(draft.detected, content, classes);
    if (!content) throw new Error("content is required before a boundary decision can be ready");

    if (mode === "block") {
      decision = "blocked";
      residual = risk("high", "policy_block");
    } else if (decision === "ready") {
      const candidate = applyDetections(content, detections, mode);
      findings = scanResidual(candidate);
      if (findings.length > 0) {
        decision = "needs_review";
        residual = risk("medium", "deterministic_residual_detected");
      } else {
        redactedContent = candidate;
        residual = risk("low", "none");
      }
    }
  } catch (error) {
    decision = "blocked";
    detections = [];
    findings = [{ class: "validation", span: [0, 0], rule: "invalid_redaction_draft" }];
    residual = {
      level: "high",
      reason_code: "invalid_redaction_draft",
      reason: "The redaction draft failed deterministic validation.",
    };
  }

  if (decision !== "ready") {
    redactedContent = "";
  }

  return {
    redaction_candidate: {
      decision,
      detected: detections,
      redacted_content: redactedContent,
      residual_risk: residual,
      scanner: {
        status: decision === "ready" ? "pass" : decision === "blocked" ? "block" : "hold",
        findings,
      },
      policy: { classes, mode, locale },
    },
  };
}

export function finalizeRedaction(inputs) {
  const candidate = requiredRecord(inputs.redaction_candidate, "redaction_candidate");
  const sourceDigest = requiredDigest(inputs.source_digest, "source_digest");
  const nativeRedactedDigest = requiredDigest(inputs.redacted_digest, "redacted_digest");
  const ready = candidate.decision === "ready";
  const redactedContent = ready && typeof candidate.redacted_content === "string"
    ? candidate.redacted_content
    : "";
  return {
    redaction_report: {
      decision: candidate.decision,
      detected: candidate.detected,
      source_digest: sourceDigest,
      redacted_digest: ready ? nativeRedactedDigest : null,
      residual_risk: candidate.residual_risk,
      scanner: candidate.scanner,
      policy: candidate.policy,
    },
    redacted_content: redactedContent,
  };
}

function parseDetections(value, source, allowedClasses) {
  const allowed = new Set(allowedClasses);
  const parsed = Array.isArray(value) ? value.map((entry, index) => {
    const detection = requiredRecord(entry, `detected[${index}]`);
    const piiClass = requiredString(detection.class, `detected[${index}].class`);
    if (!allowed.has(piiClass)) throw new Error(`detected class is outside policy: ${piiClass}`);
    const span = detection.span;
    if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isInteger)) {
      throw new Error(`detected[${index}].span must contain two integers`);
    }
    const [start, end] = span;
    if (start < 0 || end <= start || end > source.length) throw new Error(`detected[${index}].span is outside content`);
    const confidence = detection.confidence;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      throw new Error(`detected[${index}].confidence must be between 0 and 1`);
    }
    return { class: piiClass, span: [start, end], confidence };
  }) : [];

  parsed.sort((left, right) => left.span[0] - right.span[0] || left.span[1] - right.span[1]);
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].span[0] < parsed[index - 1].span[1]) throw new Error("detected spans must not overlap");
  }
  return parsed;
}

function applyDetections(source, detections, treatment) {
  const counts = new Map();
  const replacements = detections.map((detection) => {
    const label = detection.class.toUpperCase();
    const count = (counts.get(label) || 0) + 1;
    counts.set(label, count);
    return treatment === "tokenize" ? `[TOKEN:${label}:${count}]` : `[REDACTED:${label}]`;
  });
  let output = source;
  for (let index = detections.length - 1; index >= 0; index -= 1) {
    const [start, end] = detections[index].span;
    output = `${output.slice(0, start)}${replacements[index]}${output.slice(end)}`;
  }
  return output;
}

function scanResidual(value) {
  const findings = [];
  collect(findings, value, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "email", "direct_email");
  collect(findings, value, /\b\d{3}-\d{2}-\d{4}\b/gu, "government_id", "us_ssn");
  collect(findings, value, /\b(?:\d[ -]*?){13,19}\b/gu, "payment_card", "payment_card_digits", (match) => luhn(match));
  collect(findings, value, /(?<!\w)(?:\+?\d[\d().\s-]{6,}\d)(?!\w)/gu, "phone", "phone_digits", (match) => {
    const digits = match.replace(/\D/gu, "");
    return digits.length >= 10 && digits.length <= 15;
  });
  collect(findings, value, /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu, "precise_geolocation", "ipv4_address");
  collect(findings, value, /\b[A-Z0-9._%+-]+\s*(?:\[at\]|\(at\)|\sat\s)\s*[A-Z0-9.-]+\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*[A-Z]{2,}\b/giu, "email", "obfuscated_email");
  return dedupeFindings(findings);
}

function collect(findings, value, pattern, piiClass, rule, predicate = () => true) {
  for (const match of value.matchAll(pattern)) {
    if (!predicate(match[0])) continue;
    findings.push({ class: piiClass, span: [match.index, match.index + match[0].length], rule });
  }
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.class}:${finding.span[0]}:${finding.span[1]}:${finding.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function luhn(value) {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function policyClasses(value) {
  if (value === undefined || value === null) return [...DEFAULT_CLASSES];
  if (!Array.isArray(value) || value.length === 0) throw new Error("classes must be a non-empty array when supplied");
  return [...new Set(value.map((entry) => requiredString(entry, "classes entry")))].sort();
}

function residualRisk(value) {
  const parsed = record(value);
  const level = enumValue(parsed.level, ["low", "medium", "high"], "residual_risk.level");
  const reasonCode = enumValue(parsed.reason_code, REASON_CODES, "residual_risk.reason_code");
  return risk(level, reasonCode);
}

function risk(level, reasonCode) {
  const reasons = {
    none: "No deterministic residual scanner findings remain after treatment.",
    ambiguous_semantics: "Semantic identifiers remain ambiguous and require review.",
    scrubbing_destroys_meaning: "Removing the identified material would destroy the content's purpose.",
    policy_block: "The selected policy blocks boundary crossing.",
    insufficient_context: "The supplied context is insufficient for a safe boundary decision.",
    deterministic_residual_detected: "The deterministic residual scanner found identifier-shaped content.",
  };
  return { level, reason_code: reasonCode, reason: reasons[reasonCode] };
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function requiredString(value, field) {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${field} must be a non-empty string`);
  return parsed;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredRecord(value, field) {
  const parsed = record(value);
  if (Object.keys(parsed).length === 0) throw new Error(`${field} must be a non-empty object`);
  return parsed;
}

function requiredDigest(value, field) {
  const parsed = optionalString(value);
  if (!parsed || !/^sha256:[0-9a-f]{64}$/u.test(parsed)) {
    throw new Error(`${field} must be a native sha256 digest`);
  }
  return parsed;
}
