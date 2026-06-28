import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface CommandMatrixEntry {
  readonly id: string;
  readonly usage: string;
  readonly aliases?: readonly string[];
  readonly requiredPositionals: readonly string[];
  readonly conditionalPositionals?: readonly string[];
  readonly flags: readonly string[];
  readonly exitCodes: readonly number[];
  readonly parity: {
    readonly humanOutput: "semantic" | "none";
    readonly jsonOutput: "schema-exact" | "none";
    readonly receipt: "schema-exact" | "none";
    readonly sideEffect: "none" | "filesystem" | "local-runtime" | "adapter" | "external-stub";
    readonly surfaces: readonly string[];
  };
  readonly cases: readonly string[];
}

interface RuntimeSurface {
  readonly id: string;
  readonly owner: string;
  readonly parityClass: "schema-exact" | "semantic" | "fixture-backed" | "stubbed";
  readonly coveredBy: readonly string[];
  readonly notes: string;
}

interface OracleCase {
  readonly id: string;
  readonly commandId: string;
  readonly mode: "execute" | "validate";
  readonly argv?: readonly string[];
  readonly expectedExitCode?: number;
  readonly expectJson?: boolean;
  readonly expect?: {
    readonly pendingRuns: number;
    readonly firstPendingRunId: string;
    readonly firstPendingRunStatus: string;
  };
  readonly stdoutIncludes?: readonly string[];
  readonly stderrIncludes?: readonly string[];
  readonly proves: readonly string[];
}

const check = process.argv.includes("--check");
const checkHelpCoverage = process.argv.includes("--check-help-coverage");
const canonicalOnly = process.argv.includes("--canonical-only");
const root = resolve(".");
const fixturesDir = join(root, "fixtures/cli-parity");
const casesDir = join(fixturesDir, "cases");

const exitCodes = [0, 1, 2, 64] as const;

const commands: readonly CommandMatrixEntry[] = [
  command("cli.help", "runx --help", [], ["--help", "-h"], "none", ["cli-presentation"], ["help.top-level"]),
  command("new", "runx new <name>", [], ["--directory", "--json"], "filesystem", ["scaffold", "cli-presentation"], ["new.validate"]),
  command("init", "runx init", [], ["-g", "--global", "--prefetch", "--json"], "filesystem", ["scaffold", "official-skills"], ["init.validate"]),
  command("history", "runx history [query]", [], ["--skill", "--status", "--source", "--actor", "--artifact-type", "--since", "--until", "--receipt-dir", "--json"], "none", ["history", "receipts"], ["history.execute"]),
  command("resume", "runx resume <run-id> <answers.json>", [], ["--receipt-dir", "--non-interactive", "--json"], "local-runtime", ["caller-mediated-resolution", "graph-runtime", "receipts", "cli-presentation"], ["resume.validate"]),
  command("verify", "runx verify [receipt-id]", [], ["--receipt-dir", "--receipt", "--json"], "none", ["receipts", "cli-presentation"], ["verify.validate"]),
  command("list", "runx list [tools|skills|graphs|packets|overlays]", [], ["--ok-only", "--invalid-only", "--json"], "none", ["list", "tool-catalog"], ["list.tools.execute"]),
  command("config.set", "runx config set <key> <value>", [], ["--json"], "filesystem", ["config", "cli-presentation"], ["config.set.validate"]),
  command("config.get", "runx config get <key>", [], ["--json"], "filesystem", ["config", "cli-presentation"], ["config.get.validate"]),
  command("config.list", "runx config list", [], ["--json"], "filesystem", ["config", "cli-presentation"], ["config.list.execute"]),
  command("login", "runx login [--provider github|google|gitlab] [--api-base-url url] [--allow-local-api] [--json]", [], ["--provider", "--api-base-url", "--allow-local-api", "--json"], "filesystem", ["config", "cli-presentation"], ["login.validate"]),
  command("policy.inspect", "runx policy inspect <policy.json>", [], ["--json"], "none", ["policy", "cli-presentation"], ["policy.inspect.validate"]),
  command("policy.lint", "runx policy lint <policy.json>", [], ["--json"], "none", ["policy", "cli-presentation"], ["policy.lint.validate"]),
  command("publish", "runx publish <receipt.json> [--api-base-url url] [--token token] [--allow-local-api] [--json]", [], ["--api-base-url", "--token", "--allow-local-api", "--json"], "external-stub", ["receipts", "cli-presentation"], ["publish.validate"]),
  command("payment", "runx payment admission issue --input <file|-> --json", [], ["--input", "--json"], "local-runtime", ["authority", "cli-presentation"], ["payment.validate"]),
  command("kernel", "runx kernel eval --input <file|-> --json", [], ["--input", "--json"], "local-runtime", ["graph-runtime", "cli-presentation"], ["kernel.validate"]),
  command("parser", "runx parser eval --input <file|-> --json", [], ["--input", "--json"], "local-runtime", ["parser", "cli-presentation"], ["parser.validate"]),
  command("doctor", "runx doctor [path]", [], ["--json"], "filesystem", ["doctor", "cli-presentation"], ["doctor.validate"]),
  command("dev", "runx dev [root]", [], ["--lane", "--json"], "local-runtime", ["dev", "harness", "receipts"], ["dev.validate"]),
  command("export", "runx export <claude|codex> [skill-ref...]", [], ["--project", "--json"], "filesystem", ["skill-export", "cli-presentation"], ["export.validate"]),
  command("mcp.serve", "runx mcp serve <skill-ref...>", [], ["--receipt-dir"], "adapter", ["mcp", "adapter-mcp"], ["mcp.serve.validate"]),
  command("skill.run", "runx skill <skill-ref|owner/name@version|skill-dir|SKILL.md> [runner]", [], ["--registry", "--digest", "--input", "--receipt-dir", "--credential", "--secret-env", "--non-interactive", "--json"], "local-runtime", ["skill-resolution", "graph-runtime", "receipts", "sandbox", "authority", "caller-mediated-resolution", "adapter-cli-tool", "adapter-a2a", "adapter-agent"], ["skill.run.validate"]),
  command("skill.inspect", "runx skill inspect <skill-ref|owner/name@version|skill-dir|SKILL.md> [runner]", [], ["--registry", "--digest", "--json"], "filesystem", ["skill-resolution", "cli-presentation"], ["skill.inspect.validate"]),
  command("harness", "runx harness <fixture.yaml...>", [], ["--json"], "local-runtime", ["harness", "receipts", "sandbox"], ["harness.execute"]),
  command("tool.build", "runx tool build <tool-dir>|--all", [], ["--all", "--json"], "filesystem", ["tool-catalog", "authoring"], ["tool.build.validate"], { conditionalPositionals: ["<tool-dir>"] }),
  command("tool.search", "runx tool search <query>", [], ["--source", "--json"], "external-stub", ["tool-catalog", "adapter-catalog"], ["tool.search.validate"]),
  command("tool.inspect", "runx tool inspect <ref>", [], ["--source", "--json"], "external-stub", ["tool-catalog", "adapter-catalog"], ["tool.inspect.validate"]),
  command("registry", "runx registry search|read|resolve|install|publish ... --json", [], ["--registry", "--registry-dir", "--version", "--digest", "--to", "--owner", "--profile", "--limit", "--upsert", "--json"], "external-stub", ["registry", "cli-presentation"], ["registry.validate"]),
  command("add", "runx add <skill-ref|github-url>", [], ["--registry", "--version", "--ref", "--digest", "--to", "--api-base-url", "--json"], "external-stub", ["registry", "cli-presentation"], ["add.validate"]),
];

const surfaces: readonly RuntimeSurface[] = [
  surface("cli-presentation", "runx-cli", "semantic", ["cli.help", "config.list"], "Human output is normalized semantically; JSON output stays schema-exact."),
  surface("skill-resolution", "runx-cli + runx-runtime + runx-core", "fixture-backed", ["skill.run", "registry"], "Covers local paths, registry refs, and official skill resolution."),
  surface("graph-runtime", "runx-runtime", "fixture-backed", ["skill.run", "harness", "kernel"], "Covers graph execution, branching, caller handoffs, receipts, and the deterministic decision kernel."),
  surface("receipts", "runx-receipts + runx-runtime + runx-cli", "schema-exact", ["skill.run", "harness", "history", "verify"], "Receipt JSON and signature metadata are schema-exact parity surfaces."),
  surface("ledger", "runx-runtime", "schema-exact", ["history"], "Append-only run state and continuation history must survive cutover."),
  surface("sandbox", "runx-core/policy + runx-runtime", "schema-exact", ["skill.run", "harness"], "Declared and enforced sandbox metadata must remain distinct."),
  surface("harness", "runx-runtime harness via runx-cli", "fixture-backed", ["harness", "dev"], "Harness replay mode proves deterministic fixture execution and sealed receipt checks."),
  surface("history", "runx-cli + runx-runtime", "semantic", ["history"], "Search/filter behavior is command-level parity with normalized output."),
  surface("registry", "runx-cli + runx-runtime registry", "fixture-backed", ["registry"], "Local and hosted registry envelopes are exercised through native registry commands."),
  surface("tool-catalog", "runx-runtime adapters", "fixture-backed", ["tool.search", "tool.inspect", "tool.build", "list"], "Catalog discovery and local tool builds use native fixtures or local files."),
  surface("mcp", "runx-runtime adapters/mcp", "stubbed", ["mcp.serve"], "Protocol behavior uses local servers and deterministic clients."),
  surface("adapter-cli-tool", "runx-runtime cli-tool adapter", "fixture-backed", ["skill.run"], "Process invocation, env, cwd, and sandbox metadata are parity-critical."),
  surface("adapter-mcp", "runx-runtime MCP adapter", "stubbed", ["mcp.serve"], "MCP transport and tool results use local protocol fixtures."),
  surface("adapter-a2a", "runx-runtime A2A adapter", "stubbed", ["skill.run"], "A2A remains a deterministic adapter path until live provider cutover."),
  surface("adapter-catalog", "runx-runtime catalog adapter", "stubbed", ["tool.search", "tool.inspect"], "Catalog adapter inputs and normalized outputs are preserved."),
  surface("adapter-agent", "runx-runtime external agent adapter", "stubbed", ["skill.run", "dev"], "Managed agent calls are represented by local stubs, not live providers."),
  surface("config", "runx-cli", "schema-exact", ["config.set", "config.get", "config.list"], "RUNX_HOME and local config file behavior are part of CLI parity."),
  surface("doctor", "runx-cli + runx-runtime doctor", "semantic", ["doctor"], "Diagnostics can add ids, but the documented command surface must not disappear."),
  surface("dev", "runx-cli", "fixture-backed", ["dev"], "Development lanes run deterministic or recorded harness fixtures."),
  surface("skill-export", "runx-cli + runx-runtime", "semantic", ["export"], "Host-agent shims are generated from validated skill packages and delegate back to governed runx skill execution."),
  surface("parser", "runx-parser via runx-cli", "schema-exact", ["parser"], "Native parser evaluation output stays schema-exact."),
  surface("authority", "runx-core/policy", "schema-exact", ["skill.run"], "Grant, scope, and authority-kind policy remains machine-checkable without OSS brokerage."),
  surface("policy", "runx-core/policy", "schema-exact", ["policy.inspect", "policy.lint"], "Policy inspection and linting stay machine-checkable before mutation gates run."),
  surface("caller-mediated-resolution", "runx-runtime", "fixture-backed", ["skill.run"], "Required input, approvals, and agent work keep the same continuation contract."),
  surface("scaffold", "runx-cli", "semantic", ["new", "init"], "Project and standalone package scaffolds preserve command shape and generated-file intent."),
  surface("official-skills", "runx-cli", "schema-exact", ["init"], "Prefetch and lockfile behavior stays fixture-backed."),
  surface("list", "runx-cli", "semantic", ["list"], "Inventory output for tools, skills, graphs, packets, and overlays stays represented."),
  surface("authoring", "packages/authoring", "schema-exact", ["tool.build"], "Tool build output and manifest validation remain schema-exact."),
];

const casesExecutedById = new Set([
  "help.top-level",
  "config.list.execute",
  "harness.execute",
  "history.execute",
  "list.tools.execute",
]);

const cases: readonly OracleCase[] = [
  execute("help.top-level", "cli.help", ["--help"], 0, false, ["Usage:", "runx skill", "runx harness"], []),
  execute("usage.unsupported", "cli.help", ["not-a-command"], 64, false, [], ["unknown command not-a-command"]),
  execute("config.list.execute", "config.list", ["config", "list", "--json"], 0, true, [], []),
  execute("harness.execute", "harness", ["harness", "fixtures/cli-parity/harness/echo-skill.yaml", "--json"], 0, true, [], []),
  {
    id: "history.execute",
    commandId: "history",
    mode: "execute",
    argv: ["history", "--receipt-dir", "$FIXTURE_RECEIPTS", "--json"],
    expectedExitCode: 0,
    expectJson: true,
    expect: {
      pendingRuns: 1,
      firstPendingRunId: "gx_needs_agent_oracle",
      firstPendingRunStatus: "paused",
    },
    stdoutIncludes: ["\"pendingRuns\"", "\"gx_needs_agent_oracle\"", "\"selectedRunner\": \"agent-task\""],
    stderrIncludes: [],
    proves: ["history", "ledger", "receipts", "cli-presentation"],
  },
  execute("list.tools.execute", "list", ["list", "tools", "--json"], 0, true, [], []),
  ...commands
    .filter((entry) => !entry.cases.some((caseId) => casesExecutedById.has(caseId)))
    .map((entry) => validate(`${entry.id}.validate`, entry.id, entry.parity.surfaces)),
];

const files = new Map<string, string>([
  [join(fixturesDir, "README.md"), readme()],
  [join(fixturesDir, "commands.json"), stableJson({ schema: "runx.cli_feature_parity_matrix.v1", sourceOfTruth: "crates/runx-cli Rust implementation", exitCodes, commands })],
  [join(fixturesDir, "runtime-surfaces.json"), stableJson({ schema: "runx.cli_runtime_surfaces.v1", surfaces })],
  [join(casesDir, "oracle.json"), stableJson({ schema: "runx.cli_parity_oracle_cases.v1", cases })],
]);

if (canonicalOnly) {
  checkCanonicalOnly();
}

if (checkHelpCoverage) {
  checkUsageCoverage();
}

if (check) {
  checkFiles();
} else {
  writeFiles();
}

function command(
  id: string,
  usage: string,
  aliases: readonly string[],
  flags: readonly string[],
  sideEffect: CommandMatrixEntry["parity"]["sideEffect"],
  surfaces: readonly string[],
  casesForCommand: readonly string[],
  options: { readonly conditionalPositionals?: readonly string[] } = {},
): CommandMatrixEntry {
  const conditionalPositionals = new Set(options.conditionalPositionals ?? []);
  const requiredPositionals = (usage.match(/<[^>]+>/g) ?? [])
    .filter((positional) => !conditionalPositionals.has(positional));
  return {
    id,
    usage,
    aliases,
    requiredPositionals,
    ...(conditionalPositionals.size > 0 ? { conditionalPositionals: [...conditionalPositionals] } : {}),
    flags,
    exitCodes,
    parity: {
      humanOutput: "semantic",
      jsonOutput: flags.includes("--json") ? "schema-exact" : "none",
      receipt: surfaces.includes("receipts") ? "schema-exact" : "none",
      sideEffect,
      surfaces,
    },
    cases: casesForCommand,
  };
}

function surface(
  id: string,
  owner: string,
  parityClass: RuntimeSurface["parityClass"],
  coveredBy: readonly string[],
  notes: string,
): RuntimeSurface {
  return { id, owner, parityClass, coveredBy, notes };
}

function execute(
  id: string,
  commandId: string,
  argv: readonly string[],
  expectedExitCode: number,
  expectJson: boolean,
  stdoutIncludes: readonly string[],
  stderrIncludes: readonly string[],
): OracleCase {
  return {
    id,
    commandId,
    mode: "execute",
    argv,
    expectedExitCode,
    expectJson,
    stdoutIncludes,
    stderrIncludes,
    proves: commands.find((entry) => entry.id === commandId)?.parity.surfaces ?? [],
  };
}

function validate(id: string, commandId: string, proves: readonly string[]): OracleCase {
  return { id, commandId, mode: "validate", proves };
}

function readme(): string {
  return `# CLI Feature Parity Matrix

This directory captures the canonical native Rust CLI/runtime surface. The
matrix is generated from \`scripts/generate-cli-feature-parity.ts\` and checked
against \`crates/runx-cli/src/router.rs\`.

Required exit-code coverage: \`"exitCodes": [0, 1, 2, 64]\`.

## Files

- \`commands.json\`: command, alias, flag, exit-code, output, receipt, and
  side-effect coverage.
- \`runtime-surfaces.json\`: non-help runtime surfaces that must not disappear
  during a Rust rebuild.
- \`cases/oracle.json\`: executable or validation-only oracle cases.

## Parity Rules

- JSON output and receipt behavior are schema-exact.
- Human output is semantic and may be normalized for timestamps, paths,
  receipt ids, and platform-specific wording.
- Live providers are replaced by deterministic mocks, fixtures, or local
  protocol servers.
- Native CLI candidates must pass this matrix before packaging.
`;
}

function checkUsageCoverage(): void {
  const usageCommands = extractUsageCommands(readFileSync(join(root, "crates/runx-cli/src/router.rs"), "utf8"));
  const commandIds = new Set(commands.map((entry) => entry.id));
  const missing = usageCommands.flatMap((usage) =>
    helpUsageCommandIds(usage)
      .filter((id) => !commandIds.has(id))
      .map((id) => `${usage} -> ${id}`));
  if (missing.length > 0) {
    throw new Error(`CLI parity matrix is missing help usage entries:\n${missing.join("\n")}`);
  }
}

function extractUsageCommands(routerSource: string): readonly string[] {
  return extractHelpBlock(extractRustHelpText(routerSource), "Commands:");
}

function extractRustHelpText(routerSource: string): string {
  const match = routerSource.match(/pub fn help_text\(\) -> String \{\s*"\\\n([\s\S]*?)"\s*\.to_owned\(\)\s*\}/u);
  if (!match?.[1]) {
    throw new Error("Could not find help_text() string in crates/runx-cli/src/router.rs");
  }
  return match[1];
}

function extractHelpBlock(helpText: string, label: string): readonly string[] {
  const lines = helpText.split("\n");
  const start = lines.findIndex((line) => line.trim() === label);
  if (start === -1) {
    throw new Error(`Could not find ${label} block in crates/runx-cli/src/router.rs`);
  }
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      break;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("runx ")) {
      entries.push(trimmed);
    }
  }
  return entries;
}

function helpUsageCommandIds(usage: string): readonly string[] {
  if (usage.startsWith("runx skill <")) {
    return ["skill.run"];
  }
  if (usage.startsWith("runx skill inspect ")) {
    return ["skill.inspect"];
  }
  if (usage.startsWith("runx config ")) {
    return ["config.set", "config.get", "config.list"];
  }
  if (usage.startsWith("runx policy inspect|lint")) {
    return ["policy.inspect", "policy.lint"];
  }
  if (usage.startsWith("runx policy inspect")) {
    return ["policy.inspect"];
  }
  if (usage.startsWith("runx policy lint")) {
    return ["policy.lint"];
  }
  if (usage.startsWith("runx mcp serve")) {
    return ["mcp.serve"];
  }
  if (usage.startsWith("runx tool search")) {
    return ["tool.search"];
  }
  if (usage.startsWith("runx tool inspect")) {
    return ["tool.inspect"];
  }
  if (usage.startsWith("runx tool build")) {
    return ["tool.build"];
  }
  const commandName = usage.split(/\s+/)[1];
  if (!commandName) {
    return [];
  }
  return [commandName];
}

function checkCanonicalOnly(): void {
  const aliases = commands.flatMap((entry) =>
    (entry.aliases ?? []).map((alias) => `${entry.id}: ${alias}`));
  if (aliases.length > 0) {
    throw new Error(`canonical CLI matrix must not include aliases:\n${aliases.join("\n")}`);
  }
}

function checkFiles(): void {
  const stale = [...files.entries()]
    .filter(([path, contents]) => !existsSync(path) || readFileSync(path, "utf8") !== contents)
    .map(([path]) => path);
  if (stale.length > 0) {
    throw new Error(`CLI parity fixtures are stale; run this script without --check:\n${stale.join("\n")}`);
  }
  const caseFiles = readdirSync(casesDir).filter((name) => name.endsWith(".json"));
  if (!caseFiles.includes("oracle.json")) {
    throw new Error("fixtures/cli-parity/cases/oracle.json is missing");
  }
}

function writeFiles(): void {
  for (const [path, contents] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
