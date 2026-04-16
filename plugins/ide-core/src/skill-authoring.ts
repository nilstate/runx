export interface SkillDiagnostic {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path: string;
}

export interface SkillSnippet {
  readonly name: string;
  readonly prefix: string;
  readonly body: readonly string[];
  readonly description: string;
}

export interface SkillPreview {
  readonly title: string;
  readonly summary: string;
  readonly runnerMode: "portable" | "profiled";
  readonly diagnostics: readonly SkillDiagnostic[];
}

export function validateSkillMarkdown(markdown: string): readonly SkillDiagnostic[] {
  const diagnostics: SkillDiagnostic[] = [];
  if (!markdown.trim()) {
    return [{ severity: "error", path: "$", message: "Skill markdown is empty." }];
  }

  const frontmatter = extractFrontmatter(markdown);
  if (!frontmatter) {
    diagnostics.push({ severity: "warning", path: "frontmatter", message: "No YAML frontmatter found; skill will run as standard instructions only." });
    return diagnostics;
  }

  const fields = parseSimpleFrontmatterFields(frontmatter);
  if (!fields.name) {
    diagnostics.push({ severity: "error", path: "frontmatter.name", message: "Skill frontmatter should include name." });
  }
  if (!fields.description) {
    diagnostics.push({ severity: "warning", path: "frontmatter.description", message: "Skill frontmatter should include description for registry search." });
  }
  if (fields.runx) {
    diagnostics.push({ severity: "warning", path: "frontmatter.runx", message: "Normalize executable metadata into a execution profile before distribution." });
  }

  return diagnostics;
}

export function skillSnippets(): readonly SkillSnippet[] {
  return [
    {
      name: "Standard Skill",
      prefix: "runx-skill",
      description: "Portable SKILL.md with standard instructions.",
      body: ["---", "name: ${1:skill-name}", "description: ${2:What this skill does.}", "---", "", "${3:Instructions for the agent.}"],
    },
    {
      name: "CLI Binding Runner",
      prefix: "runx-binding-cli",
      description: "Materialized X.yaml cli-tool runner.",
      body: ["skill: ${1:skill-name}", "", "runners:", "  ${2:local-cli}:", "    type: cli-tool", "    command: ${3:command}", "    args: []"],
    },
    {
      name: "MCP Binding Runner",
      prefix: "runx-binding-mcp",
      description: "Materialized X.yaml MCP runner.",
      body: ["skill: ${1:skill-name}", "", "runners:", "  ${2:mcp-runner}:", "    type: mcp", "    server:", "      command: ${3:server}", "      args: []", "    tool: ${4:tool_name}"],
    },
    {
      name: "A2A Binding Runner",
      prefix: "runx-binding-a2a",
      description: "Materialized X.yaml A2A runner.",
      body: ["skill: ${1:skill-name}", "", "runners:", "  ${2:a2a-runner}:", "    type: a2a", "    agent_card_url: ${3:https://agent.example/card.json}", "    task: ${4:task}"],
    },
    {
      name: "Auth Requirement",
      prefix: "runx-auth",
      description: "Execution auth requirement for execution profile.",
      body: ["auth:", "  type: ${1:nango}", "  provider: ${2:github}", "  scopes:", "    - ${3:repo:read}"],
    },
    {
      name: "Runtime And Sandbox",
      prefix: "runx-runtime",
      description: "Runtime and sandboprofile metadata for deterministic runners.",
      body: ["runtime:", "  platforms: [darwin, linux, win32]", "  commands: [${1:command}]", "sandbox:", "  profile: ${2:workspace-write}"],
    },
    {
      name: "Input Resolution",
      prefix: "runx-inputs",
      description: "Required input declaration for runtime context collection.",
      body: ["inputs:", "  ${1:project}:", "    type: ${2:string}", "    required: true", "    description: ${3:Input description}"],
    },
    {
      name: "Chain Policy",
      prefix: "runx-chain-policy",
      description: "Chain control policy for fanout sync and escalation.",
      body: ["policy:", "  on_branch_failure:", "    strategy: ${1:halt}", "  on_conflict:", "    strategy: ${2:escalate}"],
    },
  ];
}

export function buildSkillPreview(options: { readonly markdown: string; readonly profileDocument?: string }): SkillPreview {
  const fields = parseSimpleFrontmatterFields(extractFrontmatter(options.markdown) ?? "");
  return {
    title: fields.name ?? "Untitled skill",
    summary: fields.description ?? "No description.",
    runnerMode: options.profileDocument?.trim() ? "profiled" : "portable",
    diagnostics: validateSkillMarkdown(options.markdown),
  };
}

function extractFrontmatter(markdown: string): string | undefined {
  if (!markdown.startsWith("---\n")) {
    return undefined;
  }
  const end = markdown.indexOf("\n---", 4);
  return end === -1 ? undefined : markdown.slice(4, end).trim();
}

function parseSimpleFrontmatterFields(frontmatter: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    frontmatter
      .split("\n")
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1] ?? "", (match[2] ?? "").replace(/^["']|["']$/g, "")])
      .filter(([key]) => key.length > 0),
  );
}
