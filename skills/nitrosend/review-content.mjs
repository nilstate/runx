const MAX_FINDINGS = 100;

export function projectContentReview(inputs) {
  const source = record(inputs.provider_result, "provider_result");
  const subject = boundedString(source.subject, 998, "subject");
  const html = boundedString(inputs.html, 262_144, "input.html", false);
  const expectedSubject = boundedString(inputs.subject, 998, "input.subject");
  const htmlSizeBytes = integer(source.html_size_bytes, 1, 262_144, "html_size_bytes");
  const htmlDigest = boundedString(source.html_digest, 64, "html_digest");
  const expectedDigest = boundedString(inputs.expected_html_digest, 71, "expected_html_digest");
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedDigest)) {
    throw new Error("expected_html_digest is invalid.");
  }
  if (
    subject !== expectedSubject
    || htmlSizeBytes !== utf8Bytes(html)
    || htmlDigest !== expectedDigest.slice("sha256:".length)
  ) {
    throw new Error("Nitrosend content review does not match the submitted content.");
  }
  const accessibility = record(source.accessibility, "accessibility");
  const spam = record(source.spam_score, "spam_score");
  const rating = boundedString(spam.rating, 16, "spam_score.rating");
  if (!["low", "moderate", "high", "critical"].includes(rating)) {
    throw new Error("spam_score.rating is invalid.");
  }
  return {
    subject,
    html_size_bytes: htmlSizeBytes,
    html_digest: htmlDigest,
    text_preview: boundedString(source.text_preview, 4_001, "text_preview"),
    text_length: integer(source.text_length, 0, Number.MAX_SAFE_INTEGER, "text_length"),
    accessibility: {
      valid: boolean(accessibility.valid, "accessibility.valid"),
      warnings: array(accessibility.warnings, "accessibility.warnings").map((warning, index) => {
        const item = record(warning, `accessibility.warnings[${index}]`);
        if (item.level !== "warning") throw new Error(`accessibility.warnings[${index}].level is invalid.`);
        return {
          level: "warning",
          rule: boundedString(item.rule, 256, `accessibility.warnings[${index}].rule`),
          message: boundedString(item.message, 4_000, `accessibility.warnings[${index}].message`),
          suggested_fix: boundedString(item.suggested_fix, 4_000, `accessibility.warnings[${index}].suggested_fix`),
        };
      }),
    },
    spam_score: {
      score: integer(spam.score, 0, 10, "spam_score.score"),
      rating,
      factors: array(spam.factors, "spam_score.factors").map((factor, index) => {
        const item = record(factor, `spam_score.factors[${index}]`);
        return {
          name: boundedString(item.name, 256, `spam_score.factors[${index}].name`),
          points: integer(item.points, 1, 3, `spam_score.factors[${index}].points`),
          detail: boundedString(item.detail, 4_000, `spam_score.factors[${index}].detail`),
        };
      }),
    },
    warnings: array(source.warnings, "warnings").map((warning, index) => {
      const item = record(warning, `warnings[${index}]`);
      if (item.source !== "accessibility" && item.source !== "spam") {
        throw new Error(`warnings[${index}].source is invalid.`);
      }
      return {
        source: item.source,
        rule: boundedString(item.rule, 256, `warnings[${index}].rule`),
        message: boundedString(item.message, 4_000, `warnings[${index}].message`),
        ...(item.suggested_fix === undefined
          ? {}
          : { suggested_fix: boundedString(item.suggested_fix, 4_000, `warnings[${index}].suggested_fix`) }),
      };
    }),
  };
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedString(value, maximum, label, allowEmpty = true) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function utf8Bytes(value) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
