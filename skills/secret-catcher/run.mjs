import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// secret-catcher — detect credential-like spans introduced by a code diff.
//
// Reads a unified diff, scans only ADDED lines, reports each credential-like
// span as a grounded finding, proposes (never performs) a redaction handed to
// the downstream `redact-pii` executor, and returns a block decision. The skill
// edits no files, scrubs no live content, and never quotes a raw secret: every
// finding carries a redacted preview and a one-way fingerprint only.

const SCHEMA = "secret.catcher.result.v1";
const SKILL = "secret-catcher";
const VERSION = "0.1.0";
const REDACTION_EXECUTOR = "redact-pii";
const MAX_DIFF_BYTES = 5_000_000;

function main() {
  const inputs = readInputs();
  const skillRoot = process.cwd();

  // Governed refusal: secret-catcher only PROPOSES redactions. If a caller asks
  // it to apply, edit, or write the redaction itself, it stops rather than touch
  // content — that effect belongs to the gated redact-pii executor.
  if (isTruthy(inputs.apply) || isTruthy(inputs.perform_redaction) || isTruthy(inputs.write)) {
    throw new Error(
      "refused: secret-catcher never edits files or scrubs live content. It only emits a redaction_proposal for the gated redact-pii executor. Remove 'apply' and route the proposal to redact-pii.",
    );
  }

  const diffText = resolveDiff(inputs, skillRoot);
  const scanContext = normalizeScanContext(inputs.scan_context);

  const scan = scanDiff(diffText);
  const packet = buildPacket({ scan, diffText, scanContext });

  // Fail closed: never emit output that contains a raw secret value. The scanner
  // keeps the raw spans out of `packet` by construction; this is the belt-and-
  // suspenders proof that the invariant held for this exact run.
  assertNoRawSecretLeak(packet, scan.rawSpans);

  writeArtifacts(inputs.output_dir, packet, skillRoot);

  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function resolveDiff(rawInputs, root) {
  let text;
  if (typeof rawInputs.diff === "string") {
    // A provided-but-empty diff is a valid clean scan, distinct from a missing one.
    text = rawInputs.diff;
  } else if (typeof rawInputs.diff_path === "string" && rawInputs.diff_path.length > 0) {
    const resolved = path.resolve(root, rawInputs.diff_path);
    ensureInside(root, resolved, "diff_path");
    text = fs.readFileSync(resolved, "utf8");
  } else {
    throw new Error("input 'diff' (a unified diff string) is required");
  }
  if (Buffer.byteLength(text) > MAX_DIFF_BYTES) {
    throw new Error(`diff exceeds ${MAX_DIFF_BYTES} bytes`);
  }
  return text;
}

function isTruthy(v) {
  return v === true || v === "true" || v === 1 || v === "1" || v === "yes";
}

function normalizeScanContext(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { note: value }; }
  }
  if (typeof value === "object") return value;
  return { value };
}

// ---------------------------------------------------------------------------
// detectors — high-precision, prefix- or context-anchored credential patterns
// ---------------------------------------------------------------------------
//
// Each detector yields the exact secret span it matched (`value`) plus the
// column at which the span starts inside the added line. `keep` is the number
// of leading characters that are a PUBLIC scheme identifier (e.g. `AKIA`,
// `ghp_`) and are safe to show in a redacted preview; the remainder is masked.

const DETECTORS = [
  { type: "aws_access_key_id", keep: 4, scan: whole(/\bA(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}\b/g) },
  { type: "aws_secret_access_key", keep: 0, scan: assignment(/(?:aws_secret_access_key|aws_secret_key|secret_access_key)/i, /[A-Za-z0-9/+]{40,}/) },
  { type: "github_personal_access_token", keep: 4, scan: whole(/\bghp_[A-Za-z0-9]{36}\b/g) },
  { type: "github_oauth_token", keep: 4, scan: whole(/\bgho_[A-Za-z0-9]{36}\b/g) },
  { type: "github_app_token", keep: 4, scan: whole(/\b(?:ghu|ghs)_[A-Za-z0-9]{36}\b/g) },
  { type: "github_fine_grained_pat", keep: 11, scan: whole(/\bgithub_pat_[A-Za-z0-9_]{59,}\b/g) },
  { type: "slack_token", keep: 5, scan: whole(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g) },
  { type: "slack_webhook_url", keep: 24, scan: whole(/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9]{20,}/g) },
  { type: "google_api_key", keep: 4, scan: whole(/\bAIza[0-9A-Za-z_-]{35}\b/g) },
  { type: "stripe_secret_key", keep: 8, scan: whole(/\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g) },
  { type: "openai_api_key", keep: 3, scan: whole(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g) },
  { type: "npm_access_token", keep: 4, scan: whole(/\bnpm_[A-Za-z0-9]{36}\b/g) },
  { type: "private_key_block", keep: 0, scan: whole(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g) },
  { type: "json_web_token", keep: 0, scan: whole(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g) },
  { type: "generic_secret_assignment", keep: 0, scan: genericAssignment() },
];

// A detector that matches the whole secret token by regex.
function whole(regex) {
  return (line) => {
    const out = [];
    for (const m of line.matchAll(regex)) {
      out.push({ value: m[0], start: m.index });
    }
    return out;
  };
}

// A detector that matches a secret VALUE only when it follows a key-name anchor
// on the same line (e.g. `aws_secret_access_key = <40 chars>`).
function assignment(keyRe, valueRe) {
  const combined = new RegExp(
    `(${keyRe.source})["']?\\s*[:=]\\s*["']?(${valueRe.source})`,
    "gi",
  );
  return (line) => {
    const out = [];
    for (const m of line.matchAll(combined)) {
      const value = m[2];
      const start = m.index + m[0].length - value.length - trailingQuoteLen(m[0]);
      out.push({ value, start });
    }
    return out;
  };
}

// Generic `secretName = "value"` detector, gated by entropy + a placeholder
// denylist so ordinary config and env-var references never false-block.
function genericAssignment() {
  const re = /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi;
  return (line) => {
    const out = [];
    for (const m of line.matchAll(re)) {
      const value = m[2];
      if (isPlaceholder(value)) continue;
      // Entropy floor applies at every length: a long low-entropy string
      // (e.g. a repeated token) is not a credential and must not false-block.
      if (shannonEntropy(value) < 3.0) continue;
      const start = m.index + m[0].lastIndexOf(value);
      out.push({ value, start });
    }
    return out;
  };
}

function trailingQuoteLen(matchText) {
  return /["']$/.test(matchText) ? 1 : 0;
}

function isPlaceholder(value) {
  const v = value.toLowerCase();
  if (/^(.)\1+$/.test(value)) return true; // all one repeated character
  return /example|changeme|change_me|placeholder|your[_-]?|dummy|redacted|sample|\bfake\b|test[_-]?(key|token|secret)|\bxxx+|\.\.\.|<[^>]+>|\$\{[^}]+\}|%[a-z0-9_]+%|\{\{[^}]+\}\}|process\.env|os\.environ|getenv|import\.meta\.env/.test(v);
}

function shannonEntropy(str) {
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// diff scanning
// ---------------------------------------------------------------------------

function scanDiff(diffText) {
  const findings = [];
  const rawSpans = [];
  const filesTouched = new Set();
  let addedLinesScanned = 0;

  let currentFile = null;
  let newLine = 0;
  // Remaining declared old-side / new-side lines for the current hunk. While
  // either is > 0 we are inside a hunk body and every line is content, so an
  // added line whose text happens to start with "++ ", "--", or "@@" is never
  // mistaken for a structural header. Structure is only parsed outside a body.
  let remOld = 0;
  let remNew = 0;

  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (remOld > 0 || remNew > 0) {
      const c = line[0];
      if (c === "+") {
        const content = line.slice(1);
        addedLinesScanned += 1;
        if (currentFile) filesTouched.add(currentFile);
        for (const det of DETECTORS) {
          for (const hit of det.scan(content)) {
            findings.push(makeFinding(det, hit, currentFile, newLine));
            rawSpans.push(hit.value);
          }
        }
        newLine += 1;
        remNew -= 1;
        continue;
      }
      if (c === "-") {
        remOld -= 1; // removed line: not present in the new file
        continue;
      }
      if (c === " ") {
        newLine += 1; // context line: present on both sides
        remOld -= 1;
        remNew -= 1;
        continue;
      }
      if (c === "\\") {
        continue; // "\ No newline at end of file": metadata, no line consumed
      }
      // Any other prefix means the declared hunk length was wrong or the body
      // ended early; close the body and reinterpret this line as structure.
      remOld = 0;
      remNew = 0;
    }

    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number(hunk[2]);
      remOld = hunk[1] !== undefined ? Number(hunk[1]) : 1;
      remNew = hunk[3] !== undefined ? Number(hunk[3]) : 1;
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile = parseFilePath(line.slice(4));
      continue;
    }
    // Everything else outside a hunk body (diff --git, index, --- , mode lines)
    // is metadata and is ignored.
  }

  // Deterministic, stable ordering for reproducible receipts.
  findings.sort((a, b) =>
    `${a.location.file}:${String(a.location.line).padStart(9, "0")}:${String(a.location.column).padStart(6, "0")}:${a.type}`
      .localeCompare(`${b.location.file}:${String(b.location.line).padStart(9, "0")}:${String(b.location.column).padStart(6, "0")}:${b.type}`),
  );

  return { findings, rawSpans, filesTouched: [...filesTouched].sort(), addedLinesScanned };
}

function parseFilePath(raw) {
  let p = raw.trim().split("\t")[0].trim();
  if (p === "/dev/null") return null;
  p = p.replace(/^"(.*)"$/, "$1");
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function makeFinding(det, hit, file, line) {
  return {
    type: det.type,
    location: {
      file: file || "(unknown)",
      line,
      column: hit.start + 1,
    },
    redacted_preview: redact(hit.value, det.keep),
    value_length: hit.value.length,
    fingerprint: `sha256:${sha256(hit.value).slice(0, 16)}`,
  };
}

// Reveal at most `keep` leading characters (a public scheme identifier) and
// mask the rest. The masked run is capped so previews never echo a full secret.
function redact(value, keep) {
  const shown = Math.min(keep, value.length);
  const maskedLen = Math.min(value.length - shown, 12);
  return value.slice(0, shown) + "*".repeat(maskedLen) + (value.length - shown > maskedLen ? "…" : "");
}

// ---------------------------------------------------------------------------
// packet assembly
// ---------------------------------------------------------------------------

function buildPacket({ scan, diffText, scanContext }) {
  const { findings, filesTouched, addedLinesScanned } = scan;
  const block = findings.length > 0;
  const findingTypes = [...new Set(findings.map((f) => f.type))].sort();

  const redactionProposal = block
    ? {
        decision: "proposed",
        performed_by: REDACTION_EXECUTOR,
        requires_approval: true,
        edits: findings.map((f) => ({
          file: f.location.file,
          line: f.location.line,
          column_start: f.location.column,
          column_end: f.location.column + f.value_length,
          replacement: `***REDACTED_${f.type.toUpperCase()}***`,
        })),
        note: `Proposal only. secret-catcher edits no files and scrubs no live content. The ${REDACTION_EXECUTOR} executor performs the gated edit after approval.`,
      }
    : {
        decision: "noop",
        performed_by: REDACTION_EXECUTOR,
        requires_approval: false,
        edits: [],
        note: "No credential-like spans detected in added lines; nothing to redact.",
      };

  return {
    schema: SCHEMA,
    skill: SKILL,
    version: VERSION,
    block,
    findings,
    redaction_proposal: redactionProposal,
    summary: {
      added_lines_scanned: addedLinesScanned,
      files_scanned: filesTouched.length,
      findings: findings.length,
      finding_types: findingTypes,
    },
    policy: {
      scans: "added diff lines only",
      grounded_in: "diff",
      edits_files: false,
      quotes_raw_secrets: false,
      downstream_executor: REDACTION_EXECUTOR,
      detectors: DETECTORS.map((d) => d.type),
    },
    scan_context: scanContext,
    source: {
      kind: "diff",
      bytes: Buffer.byteLength(diffText),
      sha256: sha256(diffText),
    },
    validation: {
      grounded_in_diff: true,
      every_finding_has_location: findings.every(
        (f) => f.location.file && Number.isInteger(f.location.line) && Number.isInteger(f.location.column),
      ),
      block_iff_findings: block === (findings.length > 0),
      raw_secret_values_absent: true, // proven by assertNoRawSecretLeak before emit
      finding_rule:
        "A finding is emitted only for a credential-like span on an ADDED diff line; context and removed lines are ignored, placeholders and env-var references are excluded, and no raw secret value is ever quoted.",
    },
  };
}

function assertNoRawSecretLeak(packet, rawSpans) {
  const serialized = JSON.stringify(packet);
  for (const value of rawSpans) {
    if (value && value.length >= 6 && serialized.includes(value)) {
      throw new Error("refusing to emit: a raw secret value would appear in output");
    }
  }
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

function writeArtifacts(outputDir, packet, root) {
  if (!outputDir) return;
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(packet, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), renderReport(packet));
}

function renderReport(packet) {
  const lines = [];
  lines.push("# Secret Catcher Report");
  lines.push("");
  lines.push(`- Scanner: ${packet.skill} v${packet.version}`);
  lines.push(`- Diff SHA-256: \`${packet.source.sha256}\``);
  lines.push(`- Added lines scanned: ${packet.summary.added_lines_scanned}`);
  lines.push(`- Files with additions: ${packet.summary.files_scanned}`);
  lines.push(`- Findings: ${packet.summary.findings}`);
  lines.push(`- Block: ${packet.block}`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (packet.findings.length === 0) {
    lines.push("No credential-like spans were detected on added diff lines. The clean path does not block.");
  } else {
    lines.push("| Type | Location | Redacted preview | Fingerprint |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of packet.findings) {
      lines.push(
        `| ${f.type} | ${f.location.file}:${f.location.line}:${f.location.column} | \`${f.redacted_preview}\` | \`${f.fingerprint}\` |`,
      );
    }
  }
  lines.push("");
  lines.push("## Redaction proposal");
  lines.push("");
  lines.push(`- Decision: ${packet.redaction_proposal.decision}`);
  lines.push(`- Performed by: ${packet.redaction_proposal.performed_by} (downstream, gated)`);
  lines.push(`- Requires approval: ${packet.redaction_proposal.requires_approval}`);
  lines.push(`- ${packet.redaction_proposal.note}`);
  lines.push("");
  lines.push("## Guarantees");
  lines.push("");
  lines.push("- Findings are grounded only in added diff lines.");
  lines.push("- No raw secret value appears in findings, the report, or the sealed receipt.");
  lines.push("- The skill edits no files; the redaction is a proposal for the gated `redact-pii` executor.");
  lines.push("- Clean diffs emit zero findings and do not block.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ensureInside(root, resolved, label) {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

try {
  main();
} catch (err) {
  process.stderr.write(`secret-catcher: ${err && err.message ? err.message : err}\n`);
  process.exit(64); // usage/input error
}
