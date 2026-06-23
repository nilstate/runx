import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const contract = object(inputs.contract, "contract");
const playbook = object(inputs.playbook, "playbook");
const rules = Array.isArray(playbook.rules) ? playbook.rules.filter(isObject) : [];

if (rules.length === 0) fail("playbook.rules must contain at least one supplied rule");

const clauses = extractClauses(contract);
if (!isContract(contract, clauses)) fail("contract input is non-contract or unparseable");

const redlines = [];
for (const rule of rules) {
  const normalizedRule = normalizeRule(rule);
  const clause = matchClause(clauses, normalizedRule);

  if (!clause) {
    if (normalizedRule.required) {
      redlines.push(makeRedline(normalizedRule, null, "Required clause is absent."));
    }
    continue;
  }

  for (const issue of evaluate(clause, normalizedRule)) {
    redlines.push(makeRedline(normalizedRule, clause, issue));
  }
}

redlines.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)
  || a.rule_id.localeCompare(b.rule_id)
  || (a.clause_id || "").localeCompare(b.clause_id || ""));

emit({
  clauses,
  redlines,
  risk_summary: {
    schema: "runx.contract_review.v1",
    contract_ref: text(contract.id) || "contract:unlabelled",
    playbook_ref: text(playbook.id) || "playbook:unlabelled",
    level: riskLevel(redlines),
    clause_count: clauses.length,
    redline_count: redlines.length,
    severity_counts: countBySeverity(redlines),
    read_only: true,
    effects_emitted: [],
    human_review_required: true,
    constraints: [
      "clauses_cited_from_contract_input_only",
      "rules_cited_from_playbook_input_only",
      "no_legal_decision_or_contract_effect",
    ],
  },
});

function extractClauses(value) {
  if (Array.isArray(value.clauses)) {
    return value.clauses.filter(isObject).map((clause, index) => ({
      id: text(clause.id) || `clause-${index + 1}`,
      type: slug(text(clause.type) || text(clause.title) || "general"),
      title: text(clause.title) || text(clause.type) || `Clause ${index + 1}`,
      text: redact(text(clause.text) || ""),
      source_index: index,
    })).filter((clause) => clause.text);
  }

  const source = text(value.text) || "";
  const found = [];
  const pattern = /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*)?([A-Za-z][A-Za-z /&-]{2,40})\s*:\s*([^\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    found.push({
      id: `section-${found.length + 1}`,
      type: slug(match[1]),
      title: match[1].trim(),
      text: redact(match[2].trim()),
      source_index: match.index,
    });
  }
  return found;
}

function normalizeRule(rule) {
  const id = text(rule.id);
  const requirement = text(rule.requirement) || text(rule.description);
  if (!id || !requirement) fail("each playbook rule requires id and requirement");
  return {
    id,
    clause_type: slug(text(rule.clause_type) || ""),
    requirement,
    severity: normalizeSeverity(rule.severity),
    max_days: finite(rule.max_days),
    forbidden_terms: stringArray(rule.forbidden_terms),
    required_terms: stringArray(rule.required_terms),
    require_cap: rule.require_cap === true,
    required: rule.required === true,
    keywords: stringArray(rule.keywords),
    proposed_text: text(rule.proposed_text),
  };
}

function evaluate(clause, rule) {
  const lower = clause.text.toLowerCase();
  const issues = [];

  if (rule.max_days !== null) {
    const days = [...lower.matchAll(/\b(\d{1,4})\s+days?\b/g)].map((match) => Number(match[1]));
    if (days.length > 0 && Math.max(...days) > rule.max_days) {
      issues.push(`Clause permits ${Math.max(...days)} days; playbook maximum is ${rule.max_days}.`);
    }
  }

  for (const term of rule.forbidden_terms) {
    if (lower.includes(term.toLowerCase())) issues.push(`Clause contains forbidden term: ${term}.`);
  }

  const missing = rule.required_terms.filter((term) => !lower.includes(term.toLowerCase()));
  if (missing.length > 0) issues.push(`Clause omits required term(s): ${missing.join(", ")}.`);

  if (rule.require_cap && !hasExpressCap(lower)) {
    issues.push("Clause does not contain an express liability cap.");
  }

  return issues;
}

function makeRedline(rule, clause, issue) {
  const seed = `${rule.id}\n${clause?.id || "missing"}\n${issue}`;
  return {
    redline_id: `redline-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12)}`,
    rule_id: rule.id,
    clause_id: clause?.id || null,
    clause_type: rule.clause_type || clause?.type || "unspecified",
    severity: rule.severity,
    issue,
    citation: {
      contract: clause ? { clause_id: clause.id, clause_text: clause.text } : { clause_id: null, clause_text: null },
      playbook: { rule_id: rule.id, requirement: rule.requirement },
    },
    proposed_text: rule.proposed_text,
  };
}

function matchClause(clauses, rule) {
  const exact = rule.clause_type && clauses.find((clause) => clause.type === rule.clause_type);
  if (exact) return exact;
  return clauses.find((clause) => {
    const haystack = `${clause.type} ${clause.title} ${clause.text}`.toLowerCase();
    return rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  }) || null;
}

function isContract(value, clauses) {
  if (clauses.length > 0 && Array.isArray(value.clauses)) return true;
  const source = (text(value.text) || "").toLowerCase();
  return clauses.length > 0 && /\b(agreement|party|parties|liability|termination|indemn)/.test(source);
}

function hasExpressCap(value) {
  if (/\b(unlimited|uncapped|without limitation)\b/.test(value)) return false;
  return /\b(cap(?:ped)?|limit(?:ed|ation)?)\b/.test(value)
    && /(\$|usd|fees paid|months|aggregate)/.test(value);
}

function riskLevel(values) {
  if (values.some((item) => item.severity === "high")) return "high";
  if (values.some((item) => item.severity === "medium")) return "medium";
  return values.length ? "low" : "none";
}

function countBySeverity(values) {
  return values.reduce((counts, item) => {
    counts[item.severity] += 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 });
}

function severityRank(value) {
  return { high: 3, medium: 2, low: 1 }[value] || 0;
}

function normalizeSeverity(value) {
  const normalized = (text(value) || "medium").toLowerCase();
  return ["high", "medium", "low"].includes(normalized) ? normalized : "medium";
}

function redact(value) {
  return value
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]")
    .replace(/\b(?:api[_ -]?key|password|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function object(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

