import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultSkillAdapters } from "@runxhq/adapters";
import type {
  DevFixtureAssertionContract,
  DevFixtureResultContract,
  DevReportContract,
} from "@runxhq/contracts";
import { resolvePathFromUserInput, resolveRunxHomeDir, resolveRunxWorkspaceBase } from "@runxhq/core/config";
import { parseToolManifestJson, validateToolManifest } from "@runxhq/core/parser";
import { writeLocalReceipt } from "@runxhq/core/receipts";
import { type RegistryStore } from "@runxhq/core/registry";
import { runLocalSkill, type Caller } from "@runxhq/core/runner-local";
import type { CliAgentRuntime } from "../agent-runtime.js";

import {
  buildLocalPacketIndex,
  deepEqual,
  isPlainRecord,
  sha256Stable,
  toProjectPath,
  writeJsonFile,
} from "../authoring-utils.js";
import { statusIcon, theme } from "../ui.js";
import { createDoctorDiagnostic, type DoctorCommandArgs, type DoctorReport, handleDoctorCommand } from "./doctor.js";
import { discoverToolDirectories, handleToolBuildCommand, resolveToolDirFromRef, type ToolBuildReport } from "./tool.js";
import { parse as parseYaml } from "yaml";

type FixtureAssertion = DevFixtureAssertionContract;

type DevFixtureResult = DevFixtureResultContract;

interface PreparedFixtureWorkspace {
  readonly root?: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}

export type DevReport = DevReportContract;

export interface DevCommandArgs {
  readonly devPath?: string;
  readonly devLane?: string;
  readonly devRecord: boolean;
  readonly devRealAgents: boolean;
  readonly receiptDir?: string;
}

export interface DevCommandDependencies {
  readonly resolveRegistryStoreForChains: (env: NodeJS.ProcessEnv) => Promise<RegistryStore | undefined>;
  readonly resolveDefaultReceiptDir: (env: NodeJS.ProcessEnv) => string;
  readonly createNonInteractiveCaller: (
    answers?: Readonly<Record<string, unknown>>,
    approvals?: boolean | Readonly<Record<string, boolean>>,
    loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
  ) => Caller;
  readonly createAgentRuntimeLoader: (env: NodeJS.ProcessEnv) => () => Promise<CliAgentRuntime | undefined>;
}

export async function handleDevCommand(
  parsed: DevCommandArgs,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevReport> {
  const root = resolveRunxWorkspaceBase(env);
  const unitPath = parsed.devPath ? resolvePathFromUserInput(parsed.devPath, env) : root;
  const build = await handleToolBuildCommand({ ...parsed, toolAction: "build", toolAll: true }, env);
  if (build.status === "failure") {
    return {
      schema: "runx.dev.v1",
      status: "failure",
      doctor: failedBuildDoctorReport(build),
      fixtures: [],
    };
  }
  const doctor = await handleDoctorCommand({ ...parsed, doctorPath: root, doctorFix: false } satisfies DoctorCommandArgs, env);
  if (doctor.status === "failure") {
    return { schema: "runx.dev.v1", status: "failure", doctor, fixtures: [] };
  }
  const fixturePaths = await discoverFixturePaths(unitPath, root);
  const selectedLane = parsed.devLane ?? "deterministic";
  const startedAt = Date.now();
  const fixtures: DevFixtureResult[] = [];
  for (const fixturePath of fixturePaths) {
    fixtures.push(await runDevFixture(root, fixturePath, selectedLane, parsed, env, deps));
  }
  const status = fixtures.some((fixture) => fixture.status === "failure")
    ? "failure"
    : fixtures.some((fixture) => fixture.status === "success")
      ? "success"
      : "skipped";
  const receipt = await writeLocalReceipt({
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : deps.resolveDefaultReceiptDir(env),
    runxHome: resolveRunxHomeDir(env),
    skillName: "runx.dev",
    sourceType: "dev",
    inputs: { path: parsed.devPath, lane: selectedLane },
    stdout: JSON.stringify({ fixtures: fixtures.map((fixture) => ({ name: fixture.name, status: fixture.status })) }),
    stderr: "",
    execution: {
      status: status === "failure" ? "failure" : "success",
      exitCode: status === "failure" ? 1 : 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      metadata: {
        dev: {
          fixture_count: fixtures.length,
          selected_lane: selectedLane,
        },
      },
    },
  });
  return {
    schema: "runx.dev.v1",
    status,
    doctor,
    fixtures,
    receipt_id: receipt.id,
  };
}

export function renderDevResult(result: DevReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}dev${t.reset}  ${t.dim}${result.fixtures.length} fixture(s)${t.reset}`,
  ];
  for (const fixture of result.fixtures) {
    lines.push(`  ${statusIcon(fixture.status, t)}  ${fixture.lane.padEnd(14)} ${fixture.name}  ${t.dim}${fixture.duration_ms}ms${t.reset}`);
    for (const assertion of fixture.assertions.slice(0, 3)) {
      lines.push(`     ${assertion.path}: ${assertion.message}`);
    }
  }
  if (result.receipt_id) {
    lines.push(`  ${t.dim}receipt${t.reset}  ${result.receipt_id}`);
  }
  lines.push("");
  return lines.join("\n");
}

function failedBuildDoctorReport(build: ToolBuildReport): DoctorReport {
  return {
    schema: "runx.doctor.v1",
    status: "failure",
    summary: { errors: build.errors.length, warnings: 0, infos: 0 },
    diagnostics: build.errors.map((error, index) => createDoctorDiagnostic({
      id: "runx.tool.manifest.build_failed",
      severity: "error",
      title: "Tool build failed",
      message: error,
      target: { kind: "tool" },
      location: { path: "." },
      evidence: { index },
      repairs: [{
        id: "repair_tool_build",
        kind: "manual",
        confidence: "medium",
        risk: "low",
        requires_human_review: false,
      }],
    })),
  };
}

async function discoverFixturePaths(unitPath: string, root: string): Promise<readonly string[]> {
  const statPath = existsSync(unitPath) ? unitPath : root;
  const directFixtures = path.join(statPath, "fixtures");
  const paths: string[] = [];
  for (const entry of await safeReadDir(directFixtures)) {
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      paths.push(path.join(directFixtures, entry.name));
    }
  }
  if (paths.length > 0 && statPath !== root) {
    return paths.sort();
  }
  for (const toolDir of await discoverToolDirectories(root)) {
    for (const entry of await safeReadDir(path.join(toolDir, "fixtures"))) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        paths.push(path.join(toolDir, "fixtures", entry.name));
      }
    }
  }
  return paths.sort();
}

async function runDevFixture(
  root: string,
  fixturePath: string,
  selectedLane: string,
  parsed: DevCommandArgs,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevFixtureResult> {
  const startedAt = Date.now();
  const fixture = parseYaml(await readFile(fixturePath, "utf8")) as unknown;
  if (!isPlainRecord(fixture)) {
    return failedFixture(path.basename(fixturePath), "unknown", {}, startedAt, [{
      path: "",
      kind: "exact_mismatch",
      message: "Fixture must parse to an object.",
    }]);
  }
  const name = typeof fixture.name === "string" ? fixture.name : path.basename(fixturePath, path.extname(fixturePath));
  const lane = typeof fixture.lane === "string" ? fixture.lane : "deterministic";
  const target = isPlainRecord(fixture.target) ? fixture.target : {};
  if (selectedLane !== "all" && lane !== selectedLane) {
    return {
      name,
      lane,
      target,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
      assertions: [],
      skip_reason: `lane ${lane} excluded by --lane ${selectedLane}`,
    };
  }
  if (lane === "agent") {
    return parsed.devRecord
      ? recordReplayFixture(root, fixturePath, fixture, name, lane, target, startedAt, parsed, env, deps)
      : validateReplayFixture(root, fixturePath, fixture, startedAt);
  }
  if (lane !== "deterministic") {
    return {
      name,
      lane,
      target,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
      assertions: [],
      skip_reason: `${lane} fixtures are parsed but not executed in dev v1`,
    };
  }
  const kind = typeof target.kind === "string" ? target.kind : undefined;
  if (kind === "tool") {
    return runToolFixture(root, fixturePath, fixture, name, lane, target, startedAt, env);
  }
  if (kind === "skill" || kind === "chain") {
    return runSkillFixture(root, fixture, name, lane, target, startedAt, env, deps);
  }
  return failedFixture(name, lane, target, startedAt, [{
    path: "target.kind",
    expected: "tool | skill | chain",
    actual: target.kind,
    kind: "exact_mismatch",
    message: "Fixture target.kind must be tool, skill, or chain.",
  }]);
}

async function runToolFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  env: NodeJS.ProcessEnv,
): Promise<DevFixtureResult> {
  const ref = typeof target.ref === "string" ? target.ref : "";
  const toolDir = resolveToolDirFromRef(root, ref);
  if (!toolDir) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "target.ref",
      expected: "existing tool",
      actual: ref,
      kind: "exact_mismatch",
      message: `Tool ${ref} was not found.`,
    }]);
  }
  const manifest = validateToolManifest(parseToolManifestJson(await readFile(path.join(toolDir, "manifest.json"), "utf8")));
  const command = manifest.source.command ?? "node";
  const args = manifest.source.args ?? ["./run.mjs"];
  const workspace = await prepareFixtureWorkspace(root, fixturePath, fixture, env);
  try {
    const fixtureEnv = materializeFixtureEnv(fixture.env, workspace.tokens);
    const inputs = materializeFixtureValue(isPlainRecord(fixture.inputs) ? fixture.inputs : {}, workspace.tokens);
    const execution = await runProcess(command, args, {
      cwd: toolDir,
      env: {
        ...env,
        ...fixtureEnv,
        RUNX_INPUTS_JSON: JSON.stringify(inputs),
        RUNX_CWD: workspace.root ?? root,
        RUNX_REPO_ROOT: root,
        ...(workspace.root ? { RUNX_FIXTURE_ROOT: workspace.root } : {}),
      },
    });
    const output = parseJsonMaybe(execution.stdout);
    const assertions = await assertFixtureExpectation(root, fixture.expect, execution.exitCode, output);
    return {
      name,
      lane,
      target,
      status: assertions.length === 0 ? "success" : "failure",
      duration_ms: Date.now() - startedAt,
      assertions,
      output,
    };
  } finally {
    await workspace.cleanup();
  }
}

async function prepareFixtureWorkspace(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): Promise<PreparedFixtureWorkspace> {
  const workspace = isPlainRecord(fixture.workspace) ? fixture.workspace : undefined;
  const fixtureDir = path.dirname(fixturePath);
  if (!workspace) {
    return {
      tokens: {
        RUNX_REPO_ROOT: root,
        RUNX_FIXTURE_FILE: fixturePath,
        RUNX_FIXTURE_DIR: fixtureDir,
      },
      cleanup: async () => {},
    };
  }

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "runx-fixture-"));
  const tokens = {
    RUNX_REPO_ROOT: root,
    RUNX_FIXTURE_ROOT: fixtureRoot,
    RUNX_FIXTURE_FILE: fixturePath,
    RUNX_FIXTURE_DIR: fixtureDir,
  };
  try {
    await writeFixtureFileMap(fixtureRoot, workspace.files, tokens, 0o644);
    await writeFixtureFileMap(fixtureRoot, workspace.json_files, tokens, 0o644, true);
    await writeFixtureFileMap(fixtureRoot, workspace.executable_files, tokens, 0o755);
    await initializeFixtureGit(fixtureRoot, workspace.git, tokens, env);
    return {
      root: fixtureRoot,
      tokens,
      cleanup: async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeFixtureFileMap(
  root: string,
  value: unknown,
  tokens: Readonly<Record<string, string>>,
  mode: number,
  forceJson = false,
): Promise<void> {
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [relativePath, rawContents] of Object.entries(value)) {
    const targetPath = resolveInsideFixtureRoot(root, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const contents = forceJson
      ? `${JSON.stringify(materializeFixtureValue(rawContents, tokens), null, 2)}\n`
      : typeof rawContents === "string"
        ? materializeFixtureString(rawContents, tokens)
        : `${JSON.stringify(materializeFixtureValue(rawContents, tokens), null, 2)}\n`;
    await writeFile(targetPath, contents, { mode });
  }
}

async function initializeFixtureGit(
  root: string,
  value: unknown,
  tokens: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const git = value === true ? {} : isPlainRecord(value) ? value : undefined;
  if (!git) {
    return;
  }
  const branch = typeof git.initial_branch === "string" && git.initial_branch.trim()
    ? git.initial_branch.trim()
    : "main";
  await runRequiredProcess("git", ["init", "-b", branch], root, env);
  await runRequiredProcess("git", ["config", "user.email", "fixture@example.com"], root, env);
  await runRequiredProcess("git", ["config", "user.name", "Runx Fixture"], root, env);
  if (git.commit !== false) {
    await runRequiredProcess("git", ["add", "."], root, env);
    await runRequiredProcess("git", ["commit", "-m", "fixture baseline"], root, env);
  }
  await writeFixtureFileMap(root, git.dirty_files, tokens, 0o644);
}

async function runRequiredProcess(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(command, args, { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function materializeFixtureEnv(value: unknown, tokens: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, materializeFixtureString(String(nested), tokens)]),
  );
}

function materializeFixtureValue(value: unknown, tokens: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    return materializeFixtureString(value, tokens);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeFixtureValue(entry, tokens));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, materializeFixtureValue(nested, tokens)]),
  );
}

function materializeFixtureString(value: string, tokens: Readonly<Record<string, string>>): string {
  let resolved = value;
  for (const [key, replacement] of Object.entries(tokens)) {
    resolved = resolved.split(`$${key}`).join(replacement);
    resolved = resolved.split(`\${${key}}`).join(replacement);
  }
  return resolved;
}

function resolveInsideFixtureRoot(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`fixture workspace path must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw new Error(`fixture workspace path escapes root: ${relativePath}`);
  }
  return resolved;
}

async function runSkillFixture(
  root: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevFixtureResult> {
  const ref = typeof target.ref === "string" ? target.ref : "";
  const skillPath = resolveSkillDirFromRef(root, ref);
  if (!skillPath) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "target.ref",
      expected: "existing skill",
      actual: ref,
      kind: "exact_mismatch",
      message: `Skill or chain ${ref} was not found.`,
    }]);
  }
  const result = await runLocalSkill({
    skillPath,
    inputs: isPlainRecord(fixture.inputs) ? fixture.inputs : {},
    caller: createFixtureCaller(fixture, env, deps),
    env: { ...env, RUNX_CWD: root },
    receiptDir: deps.resolveDefaultReceiptDir(env),
    runxHome: resolveRunxHomeDir(env),
    registryStore: await deps.resolveRegistryStoreForChains(env),
    adapters: createDefaultSkillAdapters(),
  });
  const success = result.status === "success";
  const output = success ? parseJsonMaybe(result.execution.stdout) : result;
  const assertions = await assertFixtureExpectation(root, fixture.expect, success ? 0 : 1, output);
  return {
    name,
    lane,
    target,
    status: assertions.length === 0 ? "success" : "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
    output,
  };
}

function createFixtureCaller(
  fixture: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Caller {
  const caller = isPlainRecord(fixture.caller) ? fixture.caller : {};
  const answers = isPlainRecord(caller.answers) ? caller.answers : {};
  const approvals = isPlainRecord(caller.approvals)
    ? Object.fromEntries(Object.entries(caller.approvals).filter(([, value]) => typeof value === "boolean")) as Readonly<Record<string, boolean>>
    : typeof caller.approvals === "boolean"
      ? caller.approvals
      : undefined;
  return deps.createNonInteractiveCaller(answers, approvals, deps.createAgentRuntimeLoader(env));
}

async function recordReplayFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  parsed: DevCommandArgs,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevFixtureResult> {
  if (!parsed.devRealAgents && !isPlainRecord(fixture.caller)) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "agent.mode",
      expected: "--real-agents or fixture.caller.answers",
      actual: "record",
      kind: "exact_mismatch",
      message: "Recording an agent fixture requires --real-agents or fixture caller answers.",
    }]);
  }
  const kind = typeof target.kind === "string" ? target.kind : undefined;
  const result = kind === "skill" || kind === "chain"
    ? await runSkillFixture(root, fixture, name, lane, target, startedAt, env, deps)
    : failedFixture(name, lane, target, startedAt, [{
        path: "target.kind",
        expected: "skill | chain",
        actual: target.kind,
        kind: "exact_mismatch",
        message: "Agent replay recording requires a skill or chain target.",
      }]);
  const replayPath = fixturePath.replace(/\.ya?ml$/i, ".replay.json");
  const cassette = {
    schema: "runx.replay.v1",
    fixture: name,
    prompt_fingerprint: fixtureFingerprint(fixture),
    recorded_at: new Date().toISOString(),
    target,
    status: result.status,
    outputs: extractReplayOutputs(fixture, result.output),
    assertions: result.assertions,
    usage: {
      mode: parsed.devRealAgents ? "real" : "fixture_answers",
    },
  };
  await writeJsonFile(replayPath, cassette);
  return {
    ...result,
    replay_path: toProjectPath(root, replayPath),
  };
}

async function validateReplayFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  startedAt: number,
): Promise<DevFixtureResult> {
  const target = isPlainRecord(fixture.target) ? fixture.target : {};
  const name = typeof fixture.name === "string" ? fixture.name : path.basename(fixturePath, path.extname(fixturePath));
  const replayPath = fixturePath.replace(/\.ya?ml$/i, ".replay.json");
  if (!existsSync(replayPath)) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "agent.mode",
      expected: "replay cassette",
      actual: "missing",
      kind: "exact_mismatch",
      message: `Missing replay cassette ${toProjectPath(root, replayPath)}.`,
    }]);
  }
  const replay = JSON.parse(readFileSync(replayPath, "utf8")) as unknown;
  const fingerprint = fixtureFingerprint(fixture);
  if (isPlainRecord(replay) && replay.prompt_fingerprint && replay.prompt_fingerprint !== fingerprint) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "replay.prompt_fingerprint",
      expected: fingerprint,
      actual: replay.prompt_fingerprint,
      kind: "exact_mismatch",
      message: "Replay cassette is stale for this fixture.",
    }]);
  }
  if (!isPlainRecord(replay)) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "replay",
      expected: "object",
      actual: replay,
      kind: "type_mismatch",
      message: "Replay cassette must be a JSON object.",
    }]);
  }
  const replayStatus = replay.status === "failure" ? 1 : 0;
  const replayOutput = isPlainRecord(replay.outputs) ? replay.outputs : replay.output;
  const assertions = await assertFixtureExpectation(root, fixture.expect, replayStatus, replayOutput);
  return {
    name,
    lane: "agent",
    target,
    status: assertions.length === 0 ? "success" : "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
    output: replayOutput,
    replay_path: toProjectPath(root, replayPath),
  };
}

function fixtureFingerprint(fixture: Readonly<Record<string, unknown>>): string {
  return sha256Stable({
    target: fixture.target,
    inputs: fixture.inputs,
    agent: fixture.agent,
    expect: fixture.expect,
  });
}

function extractReplayOutputs(fixture: Readonly<Record<string, unknown>>, output: unknown): unknown {
  const expectRecord = isPlainRecord(fixture.expect) ? fixture.expect : {};
  const outputsExpectation = isPlainRecord(expectRecord.outputs) ? expectRecord.outputs : undefined;
  if (!outputsExpectation || !isPlainRecord(output)) {
    return output;
  }
  return Object.fromEntries(
    Object.keys(outputsExpectation).map((name) => [name, selectNamedOutput(output, name)]),
  );
}

async function assertFixtureExpectation(
  root: string,
  expectation: unknown,
  exitCode: number,
  output: unknown,
): Promise<readonly FixtureAssertion[]> {
  const assertions: FixtureAssertion[] = [];
  const expectRecord = isPlainRecord(expectation) ? expectation : {};
  const expectedStatus = typeof expectRecord.status === "string" ? expectRecord.status : "success";
  const actualStatus = exitCode === 0 ? "success" : "failure";
  if (expectedStatus !== actualStatus) {
    assertions.push({
      path: "expect.status",
      expected: expectedStatus,
      actual: actualStatus,
      kind: "status_mismatch",
      message: `Expected status ${expectedStatus}, got ${actualStatus}.`,
    });
  }
  const outputExpectation = isPlainRecord(expectRecord.output) ? expectRecord.output : undefined;
  if (outputExpectation) {
    assertions.push(...await assertOutputExpectation(root, outputExpectation, output, "expect.output"));
  }
  const outputsExpectation = isPlainRecord(expectRecord.outputs) ? expectRecord.outputs : undefined;
  if (outputsExpectation) {
    for (const [name, expected] of Object.entries(outputsExpectation)) {
      const actual = selectNamedOutput(output, name);
      assertions.push(...await assertOutputExpectation(root, expected, actual, `expect.outputs.${name}`));
    }
  }
  return assertions;
}

async function assertOutputExpectation(
  root: string,
  expectation: unknown,
  output: unknown,
  basePath: string,
): Promise<readonly FixtureAssertion[]> {
  const assertions: FixtureAssertion[] = [];
  const outputExpectation = isPlainRecord(expectation) ? expectation : {};
  if ("exact" in outputExpectation && !deepEqual(output, outputExpectation.exact)) {
    assertions.push({
      path: `${basePath}.exact`,
      expected: outputExpectation.exact,
      actual: output,
      kind: "exact_mismatch",
      message: "Output did not exactly match.",
    });
  }
  if ("subset" in outputExpectation) {
    assertions.push(...assertSubset(outputExpectation.subset, output, ""));
  }
  if (typeof outputExpectation.matches_packet === "string") {
    assertions.push(...await assertMatchesPacket(root, outputExpectation.matches_packet, output, `${basePath}.matches_packet`));
  }
  return assertions;
}

function selectNamedOutput(output: unknown, name: string): unknown {
  if (!isPlainRecord(output)) {
    return output;
  }
  if (name in output) {
    return output[name];
  }
  if (isPlainRecord(output.data) && name in output.data) {
    return output.data[name];
  }
  return output;
}

function assertSubset(expected: unknown, actual: unknown, basePath: string): readonly FixtureAssertion[] {
  if (!isPlainRecord(expected)) {
    return deepEqual(expected, actual) ? [] : [{
      path: basePath,
      expected,
      actual,
      kind: "subset_miss",
      message: "Subset value did not match.",
    }];
  }
  const assertions: FixtureAssertion[] = [];
  const actualRecord = isPlainRecord(actual) ? actual : {};
  for (const [key, value] of Object.entries(expected)) {
    const pathKey = basePath ? `${basePath}.${key}` : key;
    assertions.push(...assertSubset(value, actualRecord[key], pathKey));
  }
  return assertions;
}

async function assertMatchesPacket(
  root: string,
  packetId: string,
  output: unknown,
  basePath: string,
): Promise<readonly FixtureAssertion[]> {
  const index = await buildLocalPacketIndex(root, { writeCache: false });
  const packet = index.packets.find((candidate) => candidate.id === packetId);
  if (!packet) {
    return [{
      path: basePath,
      expected: packetId,
      actual: index.packets.map((candidate) => candidate.id),
      kind: "packet_invalid",
      message: `Packet ${packetId} is not declared in this package index.`,
    }];
  }
  const outputRecord = isPlainRecord(output) ? output : undefined;
  const actualPacketId = typeof outputRecord?.schema === "string" ? outputRecord.schema : undefined;
  if (actualPacketId && actualPacketId !== packetId) {
    return [{
      path: basePath,
      expected: packetId,
      actual: actualPacketId,
      kind: "packet_invalid",
      message: "Output packet schema did not match.",
    }];
  }
  const schema = JSON.parse(await readFile(path.resolve(root, packet.path), "utf8")) as unknown;
  const data = outputRecord && "data" in outputRecord ? outputRecord.data : output;
  return validateJsonSchemaValue(schema, data, `${basePath}.data`);
}

function validateJsonSchemaValue(schema: unknown, value: unknown, basePath: string): readonly FixtureAssertion[] {
  if (!isPlainRecord(schema)) {
    return [{
      path: basePath,
      expected: "JSON Schema object",
      actual: schema,
      kind: "packet_invalid",
      message: "Packet schema artifact is not an object.",
    }];
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf) as readonly unknown[];
    const branchErrors = branches.map((branch) => validateJsonSchemaValue(branch, value, basePath));
    if (branchErrors.some((errors) => errors.length === 0)) {
      return [];
    }
    return branchErrors[0] ?? [];
  }
  const type = schema.type;
  const allowedTypes = Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === "string") : typeof type === "string" ? [type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((entry) => jsonTypeMatches(entry, value))) {
    return [{
      path: basePath,
      expected: allowedTypes.join(" | "),
      actual: jsonTypeName(value),
      kind: "type_mismatch",
      message: `Expected ${allowedTypes.join(" | ")}, got ${jsonTypeName(value)}.`,
    }];
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    return [{
      path: basePath,
      expected: schema.const,
      actual: value,
      kind: "exact_mismatch",
      message: "Value did not match schema const.",
    }];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    return [{
      path: basePath,
      expected: schema.enum,
      actual: value,
      kind: "exact_mismatch",
      message: "Value did not match schema enum.",
    }];
  }
  const assertions: FixtureAssertion[] = [];
  if ((schema.type === "object" || isPlainRecord(schema.properties)) && isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    for (const key of required) {
      if (!(key in value)) {
        assertions.push({
          path: `${basePath}.${key}`,
          expected: "required",
          actual: "missing",
          kind: "subset_miss",
          message: "Required packet field is missing.",
        });
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        assertions.push(...validateJsonSchemaValue(propertySchema, value[key], `${basePath}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          assertions.push({
            path: `${basePath}.${key}`,
            expected: "no additional property",
            actual: value[key],
            kind: "packet_invalid",
            message: "Packet includes an undeclared field.",
          });
        }
      }
    }
  }
  if ((schema.type === "array" || schema.items !== undefined) && Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      assertions.push(...validateJsonSchemaValue(schema.items, value[index], `${basePath}[${index}]`));
    }
  }
  return assertions;
}

function jsonTypeMatches(type: string, value: unknown): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isPlainRecord(value);
  return typeof value === type;
}

function jsonTypeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function failedFixture(
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  assertions: readonly FixtureAssertion[],
): DevFixtureResult {
  return {
    name,
    lane,
    target,
    status: "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
  };
}

function resolveSkillDirFromRef(root: string, ref: string): string | undefined {
  const candidates = [
    path.join(root, "skills", ref),
    path.resolve(root, ref),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "SKILL.md")));
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonMaybe(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function safeReadDir(directory: string): Promise<readonly import("node:fs").Dirent[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}
