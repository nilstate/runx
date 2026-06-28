import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GraphParseError,
  GraphValidationError,
  parseGraphYaml,
  validateGraph,
} from "../packages/cli/src/cli-parser/graph.js";
import {
  SkillValidationError,
  parseRunnerManifestYaml,
  parseSkillMarkdown,
  parseToolManifestJson,
  parseToolManifestYaml,
  validateRunnerManifest,
  validateSkill,
  validateSkillInstall,
  validateToolManifest,
} from "../packages/cli/src/cli-parser/index.js";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = path.join(workspaceRoot, "fixtures", "parser");
const check = process.argv.includes("--check");
const checkScalarSubset = process.argv.includes("--check-scalar-subset");
const selectedScopes = scopeArg();

const supportedScopes = new Set([
  "graphs",
  "installs",
  "rejections",
  "runner-manifests",
  "skills",
  "tool-manifests",
]);

if (checkScalarSubset) {
  checkScalarSubsetCompatibility();
  console.log("YAML scalar subset check passed.");
  process.exit(0);
}

for (const scope of selectedScopes ?? supportedScopes) {
  if (!supportedScopes.has(scope)) {
    throw new Error(`unsupported parser fixture scope: ${scope}`);
  }
  await writeFixtures(buildFixtures(scope), path.join(fixtureRoot, scope));
}

interface ParserFixture {
  readonly name: string;
  readonly scope: string;
  readonly input: unknown;
  readonly expected: unknown;
}

function buildFixtures(scope: string): readonly ParserFixture[] {
  if (scope === "graphs") {
    return buildGraphFixtures();
  }
  if (scope === "skills") {
    return buildSkillFixtures();
  }
  if (scope === "runner-manifests") {
    return buildRunnerManifestFixtures();
  }
  if (scope === "tool-manifests") {
    return buildToolManifestFixtures();
  }
  if (scope === "installs") {
    return buildInstallFixtures();
  }
  return [];
}

function buildGraphFixtures(): readonly ParserFixture[] {
  return [
    graphSuccess("sequential-context", `
name: sequential-echo
owner: runx
steps:
  - id: first
    skill: ../../skills/echo
    runner: echo-cli
    inputs:
      message: hello
      count: 1
    scopes:
      - filesystem:read
  - id: second
    skill: ../../skills/echo
    context:
      message: first.result
    retry:
      max_attempts: 2
      backoff_ms: 25
`),
    graphSuccess("inline-run", `
name: evolve-like
steps:
  - id: preflight
    run:
      type: cli-tool
      command: node
      args: ["-e", "process.stdout.write('{}')"]
    artifacts:
      named_emits:
        repo_profile: repo_profile
  - id: plan
    run:
      type: agent-task
      agent: builder
      task: plan
    instructions: use the parent skill environment
    context:
      repo_profile: preflight.repo_profile
`),
    graphSuccess("tool-and-policy", `
name: policy-aware
policy:
  guards:
    - step: review
      field: status
      equals: needs_review
steps:
  - id: scan
    tool: fs.read
    inputs:
      path: README.md
  - id: review
    run:
      type: agent-task
      agent: builder
      task: review
    allowed_tools:
      - fs.read
    context:
      readme: scan.result
`),
    graphSuccess("fanout-structured-gates", `
name: fanout
fanout:
  groups:
    advisors:
      strategy: quorum
      min_success: 2
      on_branch_failure: continue
      threshold_gates:
        - step: risk
          field: risk_score
          above: 0.8
          action: pause
      conflict_gates:
        - field: recommendation
          steps: [market, risk]
          action: escalate
steps:
  - id: market
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
  - id: finance
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
`),
    graphRejection("parse-malformed-yaml", "parse", "name: [unterminated"),
    graphRejection("validation-missing-step-id", "validation", `
name: bad
steps:
  - skill: ../../skills/echo
`),
    graphRejection("validation-fanout-prose-gate", "validation", `
name: fanout
fanout:
  groups:
    advisors:
      threshold_gates:
        - step: risk
          field: risk_score
          above: 0.8
          action: pause
          sentiment: negative
steps:
  - id: risk
    mode: fanout
    fanout_group: advisors
    skill: ../../skills/echo
`),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function graphSuccess(name: string, yaml: string): ParserFixture {
  return {
    name,
    scope: "graphs",
    input: { yaml: normalizeYaml(yaml) },
    expected: {
      validated: validateGraph(parseGraphYaml(normalizeYaml(yaml))),
    },
  };
}

function graphRejection(name: string, kind: "parse" | "validation", yaml: string): ParserFixture {
  const normalizedYaml = normalizeYaml(yaml);
  try {
    validateGraph(parseGraphYaml(normalizedYaml));
  } catch (error) {
    if (kind === "parse" && error instanceof GraphParseError) {
      return rejectionFixture(name, "graphs", kind, normalizedYaml, error.message);
    }
    if (kind === "validation" && error instanceof GraphValidationError) {
      return rejectionFixture(name, "graphs", kind, normalizedYaml, error.message);
    }
    throw error;
  }
  throw new Error(`graph fixture ${name} did not reject`);
}

function buildSkillFixtures(): readonly ParserFixture[] {
  return [
    skillSuccess("portable-agent", `
---
name: portable-agent
description: Portable agent skill
inputs:
  prompt:
    type: string
    required: true
---
# Portable agent

Runs with the default agent source.
`),
    skillSuccess("cli-tool-sandbox-approved-escalation", `
---
name: sandboxed-cli
source:
  type: cli-tool
  command: node
  args: ["scripts/run.mjs"]
  timeout_seconds: 30
  sandbox:
    profile: unrestricted-local-dev
    cwd_policy: workspace
    env_allowlist: ["GITHUB_TOKEN"]
    network: true
    writable_paths: ["."]
    require_enforcement: true
    approvedEscalation: true
runx:
  allowed_tools: ["fs.read"]
---
# Sandboxed CLI
`),
    skillSuccess("quality-profile", `
---
name: quality-profile
source:
  type: agent-task
  agent: reviewer
  task: review
---
# Quality profile skill

## Quality Profile

- precise
- evidence backed

### Nested Evidence

Keep nested headings inside the captured quality profile.

## Next

Ignored.
`),
    skillSuccess("graph-source", `
---
name: graph-source
source:
  type: graph
  graph:
    name: graph-backed-skill
    steps:
      - id: inspect
        run:
          type: cli-tool
          command: node
---
# Graph source
`),
    skillRejection("validation-missing-command", "validation", `
---
name: bad-cli
source:
  type: cli-tool
---
# Bad
`),
    skillRejection("validation-invalid-sandbox-profile", "validation", `
---
name: bad-sandbox
source:
  type: cli-tool
  command: node
  sandbox:
    profile: superuser
---
# Bad
`),
    skillSuccess("network-sandbox-defaults", `
---
name: network-sandbox
source:
  type: cli-tool
  command: node
  sandbox:
    profile: network
---
# Network sandbox
`),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function buildRunnerManifestFixtures(): readonly ParserFixture[] {
  return [
    runnerManifestSuccess("a2a-runner", `
skill: remote-delegate
catalog:
  kind: skill
  audience: operator
  role: canonical
runners:
  remote:
    source:
      type: a2a
      agent_card_url: https://agents.example/card.json
      agent_identity: agent:remote
      task: delegate
      arguments:
        mode: audit
    inputs:
      prompt:
        required: true
`),
    runnerManifestSuccess("harness-basic", `
skill: issue-intake
runners:
  intake:
    source:
      type: agent-task
      agent: codex
      task: triage
      outputs:
        packet: issue_intake_packet
    runx:
      post_run:
        reflect: auto
harness:
  cases:
    - name: issue thread
      runner: intake
      inputs:
        harness_context:
          receipt_ref: runx:receipt:1
          evidence_refs:
            - type: github_issue
              uri: gh://nitrosend/nitrosend/issues/1
          artifact_refs:
            - type: packet
              uri: artifact://issue-intake
      caller:
        approvals:
          mutate: true
      expect:
        status: sealed
        receipt:
          status: sealed
          source_type: agent-task
`),
    runnerManifestSuccess("execution-evidence-refs", `
runners:
  verify:
    type: cli-tool
    command: node
    execution:
      disposition: completed
      outcome_state: complete
      evidence_refs:
        - type: receipt
          uri: runx:receipt:verify
          label: receipt
      surface_refs:
        - type: artifact_refs
          uri: artifact://verify
`),
    runnerManifestRejection("validation-harness-unknown-runner", "validation", `
runners:
  known:
    type: agent
harness:
  cases:
    - name: unknown
      runner: missing
      expect:
        status: sealed
`),
    runnerManifestRejection("validation-invalid-reflect-policy", "validation", `
runners:
  bad:
    type: agent
    runx:
      post_run:
        reflect: sometimes
`),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function buildToolManifestFixtures(): readonly ParserFixture[] {
  return [
    toolManifestYamlSuccess("cli-tool", `
name: fs.read
description: Read a file.
source:
  type: cli-tool
  command: node
  args: ["tools/read.mjs"]
inputs:
  path:
    type: string
    required: true
scopes:
  - fs.read
runx:
  artifacts:
    wrap_as: file_read
`),
    toolManifestJsonSuccess("catalog-tool-json", {
      name: "catalog.run",
      source: {
        type: "catalog",
        catalog_ref: "runx://tools/catalog.run",
      },
      scopes: ["catalog.run"],
    }),
    toolManifestYamlRejection("validation-agent-source-not-tool", "validation", `
name: bad.tool
source:
  type: agent-task
  agent: codex
  task: think
`),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function buildInstallFixtures(): readonly ParserFixture[] {
  const markdown = normalizeSkillMarkdown(`
---
name: installed-skill
description: Installed fixture skill
source:
  type: cli-tool
  command: node
---
# Installed Skill
`);
  const origin = {
    source: "registry",
    source_label: "Runx Registry",
    ref: "runx://skills/installed-skill",
    skill_id: "installed-skill",
    version: "1.0.0",
    digest: "sha256:abc",
    profile_digest: "sha256:def",
    runner_names: ["default"],
    trust_tier: "verified",
  };
  return [
    {
      name: "installed-skill",
      scope: "installs",
      input: { markdown, origin },
      expected: {
        validated: validateSkillInstall(markdown, origin),
      },
    },
  ];
}

function skillSuccess(name: string, markdown: string): ParserFixture {
  const normalizedMarkdown = normalizeSkillMarkdown(markdown);
  return {
    name,
    scope: "skills",
    input: { markdown: normalizedMarkdown },
    expected: {
      validated: validateSkill(parseSkillMarkdown(normalizedMarkdown)),
    },
  };
}

function skillRejection(name: string, kind: "parse" | "validation", markdown: string): ParserFixture {
  const normalizedMarkdown = normalizeSkillMarkdown(markdown);
  try {
    validateSkill(parseSkillMarkdown(normalizedMarkdown));
  } catch (error) {
    if (kind === "parse") {
      return markdownRejectionFixture(name, kind, normalizedMarkdown, errorMessage(error));
    }
    if (kind === "validation" && isSkillValidationError(error)) {
      return markdownRejectionFixture(name, kind, normalizedMarkdown, errorMessage(error));
    }
    throw error;
  }
  throw new Error(`skill fixture ${name} did not reject`);
}

function runnerManifestSuccess(name: string, yaml: string): ParserFixture {
  const normalizedYaml = normalizeYaml(yaml);
  return {
    name,
    scope: "runner-manifests",
    input: { yaml: normalizedYaml },
    expected: {
      validated: validateRunnerManifest(parseRunnerManifestYaml(normalizedYaml)),
    },
  };
}

function runnerManifestRejection(
  name: string,
  kind: "parse" | "validation",
  yaml: string,
): ParserFixture {
  const normalizedYaml = normalizeYaml(yaml);
  try {
    validateRunnerManifest(parseRunnerManifestYaml(normalizedYaml));
  } catch (error) {
    if (kind === "parse") {
      return rejectionFixture(name, "runner-manifests", kind, normalizedYaml, errorMessage(error));
    }
    if (kind === "validation" && isSkillValidationError(error)) {
      return rejectionFixture(name, "runner-manifests", kind, normalizedYaml, errorMessage(error));
    }
    throw error;
  }
  throw new Error(`runner manifest fixture ${name} did not reject`);
}

function toolManifestYamlSuccess(name: string, yaml: string): ParserFixture {
  const normalizedYaml = normalizeYaml(yaml);
  return {
    name,
    scope: "tool-manifests",
    input: { yaml: normalizedYaml },
    expected: {
      validated: validateToolManifest(parseToolManifestYaml(normalizedYaml)),
    },
  };
}

function toolManifestJsonSuccess(name: string, manifest: unknown): ParserFixture {
  const json = stableJson(manifest);
  return {
    name,
    scope: "tool-manifests",
    input: { json },
    expected: {
      validated: validateToolManifest(parseToolManifestJson(json)),
    },
  };
}

function toolManifestYamlRejection(
  name: string,
  kind: "parse" | "validation",
  yaml: string,
): ParserFixture {
  const normalizedYaml = normalizeYaml(yaml);
  try {
    validateToolManifest(parseToolManifestYaml(normalizedYaml));
  } catch (error) {
    if (kind === "parse") {
      return rejectionFixture(name, "tool-manifests", kind, normalizedYaml, errorMessage(error));
    }
    if (kind === "validation" && isSkillValidationError(error)) {
      return rejectionFixture(name, "tool-manifests", kind, normalizedYaml, errorMessage(error));
    }
    throw error;
  }
  throw new Error(`tool manifest fixture ${name} did not reject`);
}

function markdownRejectionFixture(
  name: string,
  kind: "parse" | "validation",
  markdown: string,
  message: string,
): ParserFixture {
  return {
    name,
    scope: "skills",
    input: { markdown },
    expected: {
      rejection: { kind, message },
    },
  };
}

function rejectionFixture(
  name: string,
  scope: string,
  kind: "parse" | "validation",
  yaml: string,
  message: string,
): ParserFixture {
  return {
    name,
    scope,
    input: { yaml },
    expected: {
      rejection: { kind, message },
    },
  };
}

function normalizeYaml(yaml: string): string {
  return `${yaml.trim()}\n`;
}

function isSkillValidationError(error: unknown): error is SkillValidationError {
  return error instanceof SkillValidationError
    || Boolean(error && typeof error === "object" && "name" in error && error.name === "SkillValidationError");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeSkillMarkdown(markdown: string): string {
  return `${markdown.trim()}\n`;
}

async function writeFixtures(fixtures: readonly ParserFixture[], directory: string): Promise<void> {
  const expectedFiles = new Set<string>();
  for (const fixture of fixtures) {
    const filePath = path.join(directory, `${fixture.name}.json`);
    expectedFiles.add(filePath);
    const content = `${stableJson(fixture)}\n`;
    if (check) {
      const existing = await readFixture(filePath);
      if (existing !== content) {
        throw new Error(`fixture is stale: ${path.relative(workspaceRoot, filePath)}`);
      }
      continue;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, content);
  }

  if (check) {
    for (const filePath of await collectJsonFiles(directory)) {
      if (!expectedFiles.has(filePath)) {
        throw new Error(`stale fixture file: ${path.relative(workspaceRoot, filePath)}`);
      }
    }
  }
}

function checkScalarSubsetCompatibility(): void {
  for (const scalar of ["true", "false", "1", "1.5", "plain text", "\"yes\""]) {
    if (!scalarSubsetAllows(scalar)) {
      throw new Error(`scalar subset rejected safe scalar ${scalar}`);
    }
  }
  for (const scalar of ["yes", "NO", "0x10", "0o10", "12:34", "2026-05-18", ".nan"]) {
    if (scalarSubsetAllows(scalar)) {
      throw new Error(`scalar subset allowed divergent scalar ${scalar}`);
    }
  }
}

function scalarSubsetAllows(literal: string): boolean {
  const value = literal.trim();
  return !isBoolish(value)
    && !isBasePrefixedNumber(value)
    && !isSexagesimalLike(value)
    && !isDateLike(value)
    && !isSpecialFloat(value);
}

function isBoolish(value: string): boolean {
  return ["yes", "no", "on", "off"].some((candidate) => candidate === value.toLowerCase());
}

function isBasePrefixedNumber(value: string): boolean {
  const unsigned = value.replace(/^[+-]/u, "");
  return /^0[xX][0-9a-fA-F]+$/u.test(unsigned) || /^0o[0-7]+$/u.test(unsigned);
}

function isSexagesimalLike(value: string): boolean {
  const unsigned = value.replace(/^[+-]/u, "");
  return /^\d+(?::\d+)+$/u.test(unsigned);
}

function isDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:$|[Tt\s])/u.test(value);
}

function isSpecialFloat(value: string): boolean {
  return [".nan", ".inf", "+.inf", "-.inf"].includes(value.toLowerCase());
}

function scopeArg(): Set<string> | undefined {
  const index = process.argv.indexOf("--scope");
  if (index === -1) {
    return undefined;
  }
  return new Set(process.argv[index + 1].split(",").filter((scope) => scope.length > 0));
}

async function readFixture(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`missing fixture ${path.relative(workspaceRoot, filePath)}`);
    }
    throw error;
  }
}

async function collectJsonFiles(directory: string): Promise<readonly string[]> {
  if (!(await exists(directory))) {
    return [];
  }
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}
