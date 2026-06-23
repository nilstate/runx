import fs from "node:fs";

const inputs = readInputs();
const contract = objectInput(inputs.contract, "contract");
const playbook = objectInput(inputs.playbook, "playbook");

const contractId = stringValue(contract.id) || "contract:unlabeled";
const playbookId = stringValue(playbook.id) || "playbook:unlabeled";
const text = stringValue(contract.text) || "";
const clauses = extractClauses(contract);
const rules = Array.isArray(playbook.rules) ? playbook.rules.filter(isObject) : [];

if (!looksLikeContract(text, clauses)) {
  emit({
    decision: {
      status: "refused",
      contract_ref: contractId,
      playbook_ref: playbookId,
      reasons: ["Input does not contain enough contract structure to review."],
    },
    clauses: [],
    redlines: [],
    risk_summary: {
      level: "not_reviewed",
      reasons: ["non_contract_or_unparseable"],
      read_only: true,
    },
  });
}

if (rules.length === 0) {
  emit({
    decision: {
      status: "needs_input",
      contract_ref: contractId,
      playbook_ref: playbookId,
      reasons: ["playbook.rules must include at least one supplied rule."],
    },
    clauses,
    redlines: [],
    risk_summary: {
      level: "not_reviewed",
      reasons: ["missing_playbook_rules"],
      read_only: true,
    },
  });
}

const redlines = [];
for (const rule of rules) {
  const ruleId = stringValue(rule.id) || "rule:unlabeled";
  const clauseType = stringValue(rule.clause_type);
  const clause = findClause(clauses, clauseType, rule);

  if (!clause) {
    if (rule.required === true) {
      redlines.push({
        rule_id: ruleId,
        playbook_ref: playbookId,
        clause_id: null,
        clause_type: clauseType || "unspecified",
        severity: stringValue(rule.severity) || "medium",
        issue: "Required clause is absent from the contract.",
        citation: {
          clause_text: null,
          playbook_rule: stringValue(rule.description) || ruleId,
        },
        recommendation: stringValue(rule.recommendation) || "Add the required clause or route to legal review.",
      });
    }
    continue;
  }

  const issue = evaluateRule(clause, rule);
  if (issue) {
    redlines.push({
      rule_id: ruleId,
      playbook_ref: playbookId,
      clause_id: clause.id,
      clause_type: clause.type,
      severity: stringValue(rule.severity) || issue.severity || "medium",
      issue: issue.message,
      citation: {
        clause_text: clause.text,
        playbook_rule: stringValue(rule.description) || ruleId,
      },
      recommendation: stringValue(rule.recommendation) || issue.recommendation,
    });
  }
}

emit({
  decision: {
    status: "reviewed",
    contract_ref: contractId,
    playbook_ref: playbookId,
    reasons: redlines.length > 0
      ? ["Contract contains playbook-cited risks."]
      : ["No supplied playbook rule was breached by the extracted clauses."],
  },
  clauses,
  redlines,
  risk_summary: {
    level: riskLevel(redlines),
    redline_count: redlines.length,
    clause_count: clauses.length,
    read_only: true,
    no_effects_emitted: true,
    constraints: [
      "cite_only_present_contract_clauses",
      "cite_only_supplied_playbook_rules",
      "human_reviewer_makes_final_decision",
    ],
  },
});

function extractClauses(contract) {
  if (Array.isArray(contract.clauses)) {
    return contract.clauses
      .filter(isObject)
      .map((clause, index) => normalizeClause(clause, index))
      .filter((clause) => clause.text);
  }

  const text = stringValue(contract.text) || "";
  const headings = [
    "termination",
    "liability",
    "indemnity",
    "confidentiality",
    "governing law",
    "payment",
    "data protection",
  ];
  return headings.flatMap((heading, index) => {
    const regex = new RegExp(`(?:^|\\n)\\s*(?:\\d+\\.?\\s*)?(${escapeRegex(heading)})\\s*[:\\-]\\s*([^\\n]+)`, "i");
    const match = text.match(regex);
    if (!match) return [];
    return [{
      id: `clause-${index + 1}`,
      type: heading.replace(/\s+/g, "_"),
      title: match[1],
      text: match[2].trim(),
    }];
  });
}

function normalizeClause(clause, index) {
  return {
    id: stringValue(clause.id) || `clause-${index + 1}`,
    type: normalizeType(stringValue(clause.type) || stringValue(clause.title) || "general"),
    title: stringValue(clause.title) || stringValue(clause.type) || `Clause ${index + 1}`,
    text: stringValue(clause.text) || "",
  };
}

function evaluateRule(clause, rule) {
  const text = clause.text.toLowerCase();
  const mustInclude = stringArray(rule.must_include);
  const forbidden = stringArray(rule.forbidden_terms);
  const maxDays = numberValue(rule.max_notice_days);
  const liabilityCapRequired = rule.requires_liability_cap === true;

  const missing = mustInclude.filter((term) => !text.includes(term.toLowerCase()));
  if (missing.length > 0) {
    return {
      message: `Clause is missing required term(s): ${missing.join(", ")}.`,
      recommendation: "Revise the clause to include the playbook-required term.",
    };
  }

  const forbiddenHit = forbidden.find((term) => text.includes(term.toLowerCase()));
  if (forbiddenHit) {
    return {
      message: `Clause contains forbidden term: ${forbiddenHit}.`,
      recommendation: "Remove or replace the forbidden term.",
    };
  }

  if (maxDays !== null) {
    const days = firstDays(text);
    if (days !== null && days > maxDays) {
      return {
        message: `Notice period is ${days} days, above playbook maximum ${maxDays} days.`,
        recommendation: `Reduce notice period to ${maxDays} days or less.`,
      };
    }
  }

  if (liabilityCapRequired && !/\b(cap|capped|limit|limited)\b/.test(text)) {
    return {
      message: "Liability clause lacks an express cap.",
      recommendation: "Add a liability cap aligned with the playbook.",
    };
  }

  return null;
}

function findClause(clauses, clauseType, rule) {
  const normalized = normalizeType(clauseType || "");
  if (normalized) {
    const exact = clauses.find((clause) => clause.type === normalized);
    if (exact) return exact;
  }
  const keywords = stringArray(rule.keywords);
  return clauses.find((clause) => {
    const haystack = `${clause.type} ${clause.title} ${clause.text}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  });
}

function looksLikeContract(text, clauses) {
  if (clauses.length > 0) return true;
  const lower = text.toLowerCase();
  return lower.includes("agreement") && (
    lower.includes("party") ||
    lower.includes("term") ||
    lower.includes("liability") ||
    lower.includes("termination")
  );
}

function riskLevel(redlines) {
  if (redlines.some((item) => item.severity === "high")) return "high";
  if (redlines.length > 0) return "medium";
  return "low";
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function objectInput(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map(String).map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDays(text) {
  const match = text.match(/\b(\d{1,3})\s+days?\b/);
  return match ? Number(match[1]) : null;
}

function normalizeType(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
