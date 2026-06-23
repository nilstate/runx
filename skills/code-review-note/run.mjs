import fs from "node:fs";

const inputs = readInputs();
const prDiff = stringValue(inputs.pr_diff);
const context = objectOrString(inputs.context);

if (!prDiff || !hasDiffSignal(prDiff)) {
  emit({
    schema: "code_review_note_packet.v1",
    status: "refused",
    refusal: {
      reason_code: "invalid_input",
      message: "pr_diff is empty or not a unified diff; refusing to invent review findings.",
    },
    findings: [],
    risk: { level: "unknown", rationale: "No parseable diff was supplied." },
    test_gaps: [],
    review_note: null,
  });
  process.exit(2);
}

const parsed = parseDiff(prDiff);
if (parsed.files.length === 0) {
  emit({
    schema: "code_review_note_packet.v1",
    status: "refused",
    refusal: {
      reason_code: "invalid_input",
      message: "No changed files were found in the supplied diff.",
    },
    findings: [],
    risk: { level: "unknown", rationale: "No changed files were supplied." },
    test_gaps: [],
    review_note: null,
  });
  process.exit(2);
}

const findings = buildFindings(parsed);
const testGaps = buildTestGaps(parsed, findings, context);
const risk = summarizeRisk(findings, testGaps, parsed);
const reviewNote = buildReviewNote(findings, testGaps, risk, parsed, context);

emit({
  schema: "code_review_note_packet.v1",
  status: "sealed",
  input: {
    repository: field(context, "repository"),
    pr_number: field(context, "pr_number"),
    title: field(context, "title"),
    diff_file_count: parsed.files.length,
  },
  findings,
  risk,
  test_gaps: testGaps,
  review_note: reviewNote,
  guardrails: {
    side_effects: "none",
    posting_skill: "pr-review-note",
    merge_scope: "refused",
    grounding: "all findings cite changed files and visible diff lines",
  },
});

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    pr_diff: process.env.RUNX_INPUT_PR_DIFF,
    context: parseMaybeJson(process.env.RUNX_INPUT_CONTEXT),
  };
}

function parseMaybeJson(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectOrString(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") return { note: value };
  return {};
}

function stringValue(value) {
  return typeof value === "string" ? value : null;
}

function hasDiffSignal(diff) {
  return diff.includes("diff --git ") || diff.includes("@@");
}

function parseDiff(diff) {
  const files = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = {
        old_path: fileMatch[1],
        path: fileMatch[2],
        hunks: [],
        added: [],
        removed: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      current.hunks.push(line);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.removed.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    if (!line.startsWith("\\ No newline")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { files };
}

function buildFindings(parsed) {
  const findings = [];
  for (const file of parsed.files) {
    const addedText = file.added.map((line) => line.text).join("\n");
    const removedText = file.removed.map((line) => line.text).join("\n");
    const visibleText = `${addedText}\n${removedText}`;
    const paymentFile = /pay|refund|invoice|charge|billing/i.test(file.path);

    if (paymentFile && removedMatches(removedText, ["role", "permission", "authorize", "forbidden", "admin"])) {
      findings.push(finding({
        severity: "high",
        category: "authorization_regression",
        file,
        evidenceLine: firstRemoved(file, ["role", "permission", "authorize", "forbidden", "admin"]),
        summary: "Payment-adjacent code removes an authorization guard.",
        reproduction: "Call the changed path as a non-privileged user and verify whether the request can reach the payment/refund gateway.",
      }));
    }

    if (paymentFile && removedMatches(removedText, ["max", "threshold", "limit", "manual review", "policy"])) {
      findings.push(finding({
        severity: "high",
        category: "policy_threshold_regression",
        file,
        evidenceLine: firstRemoved(file, ["max", "threshold", "limit", "manual review", "policy"]),
        summary: "Payment policy threshold handling was removed or weakened.",
        reproduction: "Submit an over-threshold payment/refund request and confirm it is escalated instead of proposed automatically.",
      }));
    }

    if (/\bTODO\b|restore|temporary|after migration/i.test(addedText)) {
      findings.push(finding({
        severity: paymentFile ? "medium" : "low",
        category: "temporary_control_gap",
        file,
        evidenceLine: firstAdded(file, ["TODO", "restore", "temporary", "migration"]),
        summary: "New code marks a control as temporary or deferred.",
        reproduction: "Inspect the follow-up condition and add a regression test that fails while the control remains disabled.",
      }));
    }

    if (/Number\(|parseInt\(|parseFloat\(/.test(addedText) && !/Number\.isFinite|isNaN|zod|schema|validate/i.test(visibleText)) {
      findings.push(finding({
        severity: "medium",
        category: "unchecked_numeric_parse",
        file,
        evidenceLine: firstAdded(file, ["Number(", "parseInt(", "parseFloat("]),
        summary: "Numeric parsing is added without an explicit finite-number validation path.",
        reproduction: "Exercise the path with empty, NaN, negative, and string amount inputs and verify the result cannot bypass policy checks.",
      }));
    }
  }
  return findings;
}

function buildTestGaps(parsed, findings, context) {
  const changedPaths = parsed.files.map((file) => file.path);
  const hasTests = changedPaths.some((path) => /(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\.[jt]sx?$/i.test(path));
  const gaps = [];

  if (!hasTests && findings.some((item) => item.severity === "high")) {
    gaps.push({
      name: "missing_high_risk_regression_tests",
      detail: "No test file changed while high-risk behavior changed.",
      expected_coverage: "Add authorization, policy-threshold, and negative-input regression tests for the changed path.",
    });
  }
  if (findings.some((item) => item.category === "unchecked_numeric_parse")) {
    gaps.push({
      name: "missing_numeric_boundary_tests",
      detail: "The diff adds numeric parsing without visible boundary coverage.",
      expected_coverage: "Cover zero, empty string, NaN, negative, and over-limit values.",
    });
  }
  const policy = field(context, "test_policy");
  if (policy && gaps.length === 0 && !hasTests) {
    gaps.push({
      name: "policy_named_tests_not_visible",
      detail: `Context test policy says: ${policy}`,
      expected_coverage: "Show the policy-specific regression test in the PR diff or link it in review context.",
    });
  }
  return gaps;
}

function summarizeRisk(findings, testGaps, parsed) {
  const severities = findings.map((item) => item.severity);
  let level = "low";
  if (severities.includes("high")) level = "high";
  else if (severities.includes("medium")) level = "medium";
  if (level === "low" && testGaps.length > 0) level = "medium";
  return {
    level,
    finding_count: findings.length,
    changed_files: parsed.files.map((file) => file.path),
    rationale: findings.length > 0
      ? `Risk is ${level} because ${findings.length} grounded finding(s) were visible in the supplied diff.`
      : "Risk is low because no concrete blocker was visible in the supplied diff.",
  };
}

function buildReviewNote(findings, testGaps, risk, parsed, context) {
  const repo = field(context, "repository") ?? "unknown repository";
  const pr = field(context, "pr_number") ?? "unknown PR";
  const lines = [];
  lines.push(`Review note for ${repo}#${pr}`);
  lines.push("");
  lines.push(`Risk: ${risk.level} (${risk.finding_count} finding(s))`);
  lines.push("");
  if (findings.length > 0) {
    lines.push("Findings:");
    for (const item of findings) {
      lines.push(`- [${item.severity}] ${item.file}:${item.line} ${item.summary}`);
      lines.push(`  Reproduction: ${item.reproduction}`);
    }
  } else {
    lines.push("Findings: no blocking issue visible in the supplied diff.");
  }
  lines.push("");
  if (testGaps.length > 0) {
    lines.push("Test gaps:");
    for (const gap of testGaps) {
      lines.push(`- ${gap.name}: ${gap.expected_coverage}`);
    }
  } else {
    lines.push("Test gaps: none visible from the supplied context.");
  }
  lines.push("");
  lines.push("Scope: proposed comment only; posting requires pr.comment authority through pr-review-note. Merge is out of scope.");

  return {
    effect: "proposed",
    catalog_skill: "pr-review-note",
    required_scope: "pr.comment",
    merge_scope: "refused",
    target: { repository: repo, pr_number: pr },
    body: lines.join("\n"),
  };
}

function finding({ severity, category, file, evidenceLine, summary, reproduction }) {
  return {
    severity,
    category,
    file: file.path,
    line: evidenceLine?.line ?? null,
    evidence: evidenceLine?.text ?? null,
    summary,
    reproduction,
    source: "supplied_diff",
  };
}

function removedMatches(text, patterns) {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(text));
}

function firstRemoved(file, needles) {
  return firstLine(file.removed, needles);
}

function firstAdded(file, needles) {
  return firstLine(file.added, needles);
}

function firstLine(lines, needles) {
  return lines.find((line) => needles.some((needle) => line.text.toLowerCase().includes(needle.toLowerCase()))) ?? lines[0] ?? null;
}

function field(context, key) {
  const value = context?.[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
