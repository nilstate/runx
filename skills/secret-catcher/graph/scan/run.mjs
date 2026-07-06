import fs from "node:fs";

const input = readInputs();
const diff = typeof input.diff === "string" ? input.diff : "";
if (!diff.trim()) {
  process.stderr.write("secret-catcher requires a non-empty diff\n");
  process.exit(2);
}
const findings = [];
const seen = new Set();

const detectors = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["github_token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i],
  ["secret_assignment", /\b(?:api[_-]?key|api[_-]?token|secret|password|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];

let newLine = 0;
for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith("@@")) {
    const match = line.match(/\+(\d+)/);
    newLine = match ? Number(match[1]) - 1 : newLine;
    continue;
  }
  if (line.startsWith("+++")) continue;
  if (line.startsWith("+")) {
    newLine += 1;
    const content = line.slice(1);
    for (const [type, pattern] of detectors) {
      if (!pattern.test(content)) continue;
      const location = `added-line:${newLine}`;
      const key = `${type}:${location}`;
      if (!seen.has(key)) findings.push({ type, location });
      seen.add(key);
    }
  } else if (!line.startsWith("-")) {
    newLine += 1;
  }
}

const block = findings.length > 0;
const scanResult = {
  findings,
  redaction_proposal: block
    ? {
        status: "gated_proposal",
        consumer: "redact-pii",
        locations: [...new Set(findings.map((finding) => finding.location))],
        instruction: "Remove the credential value and rotate it outside this skill before retrying.",
      }
    : null,
  block,
  evidence: {
    inspected_added_lines: diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    finding_count: findings.length,
    raw_values_emitted: false,
    scan_context: safeContext(input.scan_context),
  },
};

process.stdout.write(`${JSON.stringify({ scan_result: scanResult }, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

function safeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    repository: typeof value.repository === "string" ? value.repository : null,
    pull_request: Number.isFinite(Number(value.pull_request)) ? Number(value.pull_request) : null,
  };
}
