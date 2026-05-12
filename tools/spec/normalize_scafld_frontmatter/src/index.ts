import {
  defineTool,
  stringInput,
} from "@runxhq/authoring";

const validSizes = new Set(["small", "medium", "large"]);
const validRisks = new Set(["low", "medium", "high"]);

export default defineTool({
  name: "spec.normalize_scafld_frontmatter",
  description: "Normalize scafld 2 markdown frontmatter before writing an agent-authored spec.",
  inputs: {
    spec_contents: stringInput({ description: "Agent-authored scafld markdown spec contents." }),
    task_id: stringInput({ optional: true, description: "Expected scafld task id." }),
    thread_title: stringInput({ optional: true, description: "Expected non-empty scafld title." }),
    size: stringInput({ optional: true, description: "Expected scafld size: small, medium, or large." }),
    risk: stringInput({ optional: true, description: "Expected scafld risk: low, medium, or high." }),
  },
  output: {
    packet: "runx.spec.normalized_scafld_spec.v1",
    wrap_as: "normalized_spec",
  },
  scopes: ["spec.normalize_scafld_frontmatter"],
  run: runNormalizeScafldFrontmatter,
});

function runNormalizeScafldFrontmatter({ inputs }) {
  const original = String(inputs.spec_contents ?? "");
  const parsed = parseFrontmatter(original);
  const existing = parsed.frontmatter;
  const repairs: string[] = [];

  const taskId = firstNonEmpty(inputs.task_id, existing.task_id) ?? "issue-to-pr";
  const title = firstNonEmpty(existing.title, inputs.thread_title, taskId) ?? taskId;
  const size = normalizeSize(firstNonEmpty(inputs.size, existing.size));
  const risk = normalizeRisk(firstNonEmpty(inputs.risk, existing.risk_level));
  const created = firstNonEmpty(existing.created, new Date(0).toISOString());
  const updated = firstNonEmpty(existing.updated, created);

  const required = {
    spec_version: "'2.0'",
    task_id: taskId,
    created,
    updated,
    title,
    status: "draft",
    harden_status: "not_run",
    size,
    risk_level: risk,
  };

  for (const [key, value] of Object.entries(required)) {
    if (existing[key] !== value) {
      repairs.push(key);
    }
  }

  const body = ensureTitleHeading(parsed.body, title);
  if (body !== parsed.body.replace(/^\s+/, "")) {
    repairs.push("title_heading");
  }

  const contents = [
    "---",
    ...Object.entries(required).map(([key, value]) => `${key}: ${quoteYamlIfNeeded(value)}`),
    "---",
    "",
    body,
  ].join("\n").replace(/\n*$/u, "\n");

  return {
    contents,
    frontmatter: required,
    changed: contents !== original,
    repairs,
  };
}

function parseFrontmatter(contents: string): {
  readonly frontmatter: Record<string, string>;
  readonly body: string;
} {
  const normalized = contents.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const rawFrontmatter = normalized.slice(4, end);
  const bodyStart = normalized.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1);
  const frontmatter: Record<string, string> = {};
  for (const line of rawFrontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u);
    if (!match) {
      continue;
    }
    frontmatter[match[1]] = stripYamlQuotes(match[2]);
  }
  return { frontmatter, body };
}

function normalizeSize(value: string | undefined): string {
  const normalized = String(value || "small").trim().toLowerCase();
  if (validSizes.has(normalized)) {
    return normalized;
  }
  return "small";
}

function normalizeRisk(value: string | undefined): string {
  const normalized = String(value || "low").trim().toLowerCase();
  if (validRisks.has(normalized)) {
    return normalized;
  }
  return "low";
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function ensureTitleHeading(body: string, title: string): string {
  const trimmed = body.replace(/^\s+/, "");
  const lines = trimmed.split("\n");
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (line.startsWith("# ")) {
      lines[index] = `# ${title}`;
      return lines.join("\n").replace(/^\n+/, "");
    }
  }
  return [`# ${title}`, "", trimmed].join("\n").replace(/\n*$/u, "\n");
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteYamlIfNeeded(value: string | undefined): string {
  const text = String(value ?? "");
  if (/^'.*'$/u.test(text)) {
    return text;
  }
  if (!text || /[:#\n\r]/u.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}
