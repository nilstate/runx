import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseDocument } from "yaml";

import { resolveLocalSkillProfile } from "../config/index.js";
import {
  parseSkillMarkdown,
  parseRunnerManifestYaml,
  validateRunnerManifest,
  type HarnessCallerFixture,
  type HarnessExpectation,
  type HarnessReceiptExpectation,
  type RunnerHarnessCase,
} from "../parser/index.js";
import {
  runLocalGraph,
  runLocalSkill,
  type Caller,
  type ExecutionEvent,
  type RunLocalGraphResult,
  type RunLocalSkillResult,
} from "../runner-local/index.js";
import type { RegistryStore } from "../registry/index.js";
import type { ToolCatalogAdapter } from "../tool-catalogs/index.js";
import type { ResolutionRequest, ResolutionResponse, SkillAdapter } from "../executor/index.js";

type HarnessKind = "skill" | "graph";

export interface HarnessFixture {
  readonly name: string;
  readonly kind: HarnessKind;
  readonly target: string;
  readonly runner?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string>>;
  readonly caller: HarnessCallerFixture;
  readonly expect: HarnessExpectation;
}

export interface HarnessRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly keepFiles?: boolean;
  readonly registryStore?: RegistryStore;
  readonly skillCacheDir?: string;
  readonly toolCatalogAdapters?: readonly ToolCatalogAdapter[];
  readonly adapters?: readonly SkillAdapter[];
  readonly voiceProfilePath?: string;
}

export interface CallerTrace {
  readonly resolutions: readonly {
    readonly request: ResolutionRequest;
    readonly response?: ResolutionResponse;
  }[];
  readonly events: readonly ExecutionEvent[];
}

export interface HarnessRunResult {
  readonly source: "fixture" | "inline";
  readonly fixture: HarnessFixture;
  readonly fixturePath: string;
  readonly targetPath: string;
  readonly receiptDir: string;
  readonly runxHome: string;
  readonly status: RunLocalSkillResult["status"] | RunLocalGraphResult["status"];
  readonly receipt?: RunLocalSkillResult extends infer SkillResult
    ? SkillResult extends { readonly receipt: infer Receipt }
      ? Receipt
      : never
    : never;
  readonly graphReceipt?: RunLocalGraphResult extends infer GraphResult
    ? GraphResult extends { readonly receipt: infer Receipt }
      ? Receipt
      : never
    : never;
  readonly trace: CallerTrace;
  readonly assertionErrors: readonly string[];
}

export interface HarnessSuiteResult {
  readonly source: "inline";
  readonly targetPath: string;
  readonly skillPath: string;
  readonly profileSourcePath: string;
  readonly status: "success" | "failure";
  readonly cases: readonly HarnessRunResult[];
  readonly assertionErrors: readonly string[];
}

export type HarnessTargetResult = HarnessRunResult | HarnessSuiteResult;

interface ResolvedInlineHarnessTarget {
  readonly skillPath: string;
  readonly profileDocument: string;
  readonly profileSourcePath: string;
}

export async function parseHarnessFixtureFile(fixturePath: string): Promise<HarnessFixture> {
  return parseHarnessFixture(await readFile(fixturePath, "utf8"));
}

export function parseHarnessFixture(contents: string): HarnessFixture {
  const document = parseDocument(contents, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error: { readonly message: string }) => error.message).join("; "));
  }

  const parsed = document.toJS() as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Harness fixture must be a YAML object.");
  }

  const kind = requiredString(parsed.kind, "kind");
  if (kind !== "skill" && kind !== "graph") {
    throw new Error("Harness fixture kind must be skill or graph.");
  }

  return {
    name: requiredString(parsed.name, "name"),
    kind,
    target: requiredString(parsed.target, "target"),
    runner: optionalString(parsed.runner, "runner"),
    inputs: optionalRecord(parsed.inputs, "inputs") ?? {},
    env: validateEnv(optionalRecord(parsed.env, "env") ?? {}),
    caller: validateCaller(optionalRecord(parsed.caller, "caller") ?? {}),
    expect: validateExpectation(optionalRecord(parsed.expect, "expect") ?? {}),
  };
}

export async function runHarnessTarget(targetPath: string, options: HarnessRunOptions = {}): Promise<HarnessTargetResult> {
  const resolvedTargetPath = path.resolve(targetPath);
  const targetStat = await stat(resolvedTargetPath);

  if (isInlineHarnessTarget(resolvedTargetPath, targetStat)) {
    return await runInlineHarnessSuite(resolvedTargetPath, options);
  }

  return await runHarness(resolvedTargetPath, options);
}

export async function runHarness(fixturePath: string, options: HarnessRunOptions = {}): Promise<HarnessRunResult> {
  const resolvedFixturePath = path.resolve(fixturePath);
  const fixture = await parseHarnessFixtureFile(resolvedFixturePath);
  const fixtureDir = path.dirname(resolvedFixturePath);
  const targetPath = path.resolve(fixtureDir, fixture.target);
  return await executeHarnessFixture({
    fixture,
    fixturePath: resolvedFixturePath,
    targetPath,
    source: "fixture",
    options,
  });
}

async function runInlineHarnessSuite(targetPath: string, options: HarnessRunOptions): Promise<HarnessSuiteResult> {
  const resolved = await resolveInlineHarnessTarget(targetPath);
  const manifest = validateRunnerManifest(parseRunnerManifestYaml(resolved.profileDocument));
  if (!manifest.harness || manifest.harness.cases.length === 0) {
    throw new Error(`Inline harness target does not declare harness.cases: ${resolved.profileSourcePath}`);
  }

  const cases: HarnessRunResult[] = [];
  for (const entry of manifest.harness.cases) {
    const fixture = createInlineHarnessFixture(entry, resolved.skillPath);
    cases.push(
      await executeHarnessFixture({
        fixture,
        fixturePath: resolved.profileSourcePath,
        targetPath: resolved.skillPath,
        source: "inline",
        options,
      }),
    );
  }

  const assertionErrors = cases.flatMap((result) => result.assertionErrors.map((error) => `${result.fixture.name}: ${error}`));
  return {
    source: "inline",
    targetPath: resolved.skillPath,
    skillPath: resolved.skillPath,
    profileSourcePath: resolved.profileSourcePath,
    status: assertionErrors.length === 0 ? "success" : "failure",
    cases,
    assertionErrors,
  };
}

async function executeHarnessFixture(args: {
  readonly fixture: HarnessFixture;
  readonly fixturePath: string;
  readonly targetPath: string;
  readonly source: "fixture" | "inline";
  readonly options: HarnessRunOptions;
}): Promise<HarnessRunResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-harness-"));
  const receiptDir = path.join(tempDir, "receipts");
  const runxHome = path.join(tempDir, "home");
  const trace = createTrace();
  const caller = createReplayCaller(args.fixture.caller, trace);
  const env = {
    ...(args.options.env ?? process.env),
    ...args.fixture.env,
    RUNX_RECEIPT_DIR: receiptDir,
    RUNX_HOME: runxHome,
    // Sandbox cli-tool skills to the harness tempdir so tools like
    // scafld that persist state to cwd do not leak files into the
    // runx repo when harness cases run against cli-tool skills.
    RUNX_CWD: tempDir,
    INIT_CWD: tempDir,
  };

  try {
    const result =
      args.fixture.kind === "skill"
        ? await runLocalSkill({
            skillPath: args.targetPath,
            runner: args.fixture.runner,
            inputs: args.fixture.inputs,
            caller,
            env,
            receiptDir,
            runxHome,
            registryStore: args.options.registryStore,
            skillCacheDir: args.options.skillCacheDir,
            toolCatalogAdapters: args.options.toolCatalogAdapters,
            adapters: args.options.adapters,
            voiceProfilePath: args.options.voiceProfilePath,
          })
        : await runLocalGraph({
            graphPath: args.targetPath,
            inputs: args.fixture.inputs,
            caller,
            env,
            receiptDir,
            runxHome,
            registryStore: args.options.registryStore,
            skillCacheDir: args.options.skillCacheDir,
            toolCatalogAdapters: args.options.toolCatalogAdapters,
            adapters: args.options.adapters,
            voiceProfilePath: args.options.voiceProfilePath,
          });

    const assertionErrors = assertHarnessResult(args.fixture, result);
    return {
      source: args.source,
      fixture: args.fixture,
      fixturePath: args.fixturePath,
      targetPath: args.targetPath,
      receiptDir,
      runxHome,
      status: result.status,
      receipt: skillReceipt(result),
      graphReceipt: graphReceipt(result),
      trace,
      assertionErrors,
    };
  } finally {
    if (!args.options.keepFiles) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function createInlineHarnessFixture(entry: RunnerHarnessCase, skillPath: string): HarnessFixture {
  return {
    name: entry.name,
    kind: "skill",
    target: skillPath,
    runner: entry.runner,
    inputs: entry.inputs,
    env: entry.env,
    caller: entry.caller,
    expect: entry.expect,
  };
}

async function resolveInlineHarnessTarget(targetPath: string): Promise<ResolvedInlineHarnessTarget> {
  const resolvedTargetPath = path.resolve(targetPath);
  const targetStat = await stat(resolvedTargetPath);
  const skillPath = targetStat.isDirectory() ? path.join(resolvedTargetPath, "SKILL.md") : resolvedTargetPath;
  const basename = path.basename(skillPath).toLowerCase();
  if (basename !== "skill.md") {
    throw new Error(`Inline harness target must be a skill directory or SKILL.md: ${resolvedTargetPath}`);
  }

  const markdown = await readFile(skillPath, "utf8");
  const raw = parseSkillMarkdown(markdown);
  const skillName = requiredString(raw.frontmatter.name, "frontmatter.name");
  const profile = await resolveLocalSkillProfile(skillPath, skillName);
  if (!profile.profileDocument || !profile.profileSourcePath) {
    throw new Error(`Inline harness target does not have a execution profile: ${resolvedTargetPath}`);
  }

  return {
    skillPath: path.dirname(skillPath),
    profileDocument: profile.profileDocument,
    profileSourcePath: profile.profileSourcePath,
  };
}

function isInlineHarnessTarget(targetPath: string, targetStat: Awaited<ReturnType<typeof stat>>): boolean {
  if (targetStat.isDirectory()) {
    return true;
  }
  const basename = path.basename(targetPath).toLowerCase();
  return basename === "skill.md";
}

function assertHarnessResult(
  fixture: HarnessFixture,
  result: RunLocalSkillResult | RunLocalGraphResult,
): readonly string[] {
  const errors: string[] = [];

  if (fixture.expect.status && result.status !== fixture.expect.status) {
    errors.push(`Expected status ${fixture.expect.status}, got ${result.status}.`);
  }

  const receipt = skillReceipt(result) ?? graphReceipt(result);
  if (fixture.expect.receipt) {
    if (!receipt) {
      errors.push("Expected a receipt, but run did not produce one.");
    } else {
      if (fixture.expect.receipt.kind && receipt.kind !== fixture.expect.receipt.kind) {
        errors.push(`Expected receipt kind ${fixture.expect.receipt.kind}, got ${receipt.kind}.`);
      }
      if (fixture.expect.receipt.status && receipt.status !== fixture.expect.receipt.status) {
        errors.push(`Expected receipt status ${fixture.expect.receipt.status}, got ${receipt.status}.`);
      }
      if (fixture.expect.receipt.skill_name && receipt.kind !== "skill_execution") {
        errors.push(`Expected skill_execution receipt for skill_name ${fixture.expect.receipt.skill_name}.`);
      } else if (
        fixture.expect.receipt.skill_name
        && receipt.kind === "skill_execution"
        && receipt.skill_name !== fixture.expect.receipt.skill_name
      ) {
        errors.push(`Expected receipt skill_name to equal ${fixture.expect.receipt.skill_name}.`);
      }
      if (fixture.expect.receipt.source_type && receipt.kind !== "skill_execution") {
        errors.push(`Expected skill_execution receipt for source_type ${fixture.expect.receipt.source_type}.`);
      } else if (
        fixture.expect.receipt.source_type
        && receipt.kind === "skill_execution"
        && receipt.source_type !== fixture.expect.receipt.source_type
      ) {
        errors.push(`Expected receipt source_type to equal ${fixture.expect.receipt.source_type}.`);
      }
      if (fixture.expect.receipt.graph_name && receipt.kind !== "graph_execution") {
        errors.push(`Expected graph_execution receipt for graph_name ${fixture.expect.receipt.graph_name}.`);
      } else if (
        fixture.expect.receipt.graph_name
        && receipt.kind === "graph_execution"
        && receipt.graph_name !== fixture.expect.receipt.graph_name
      ) {
        errors.push(`Expected receipt graph_name to equal ${fixture.expect.receipt.graph_name}.`);
      }
      if (
        fixture.expect.receipt.owner
        && receipt.kind === "graph_execution"
        && receipt.owner !== fixture.expect.receipt.owner
      ) {
        errors.push(`Expected receipt owner to equal ${fixture.expect.receipt.owner}.`);
      }
    }
  }

  if (fixture.expect.steps) {
    const actualSteps =
      receipt?.kind === "graph_execution"
        ? receipt.steps.map((step) => step.step_id)
        : "steps" in result
          ? result.steps.map((step) => step.stepId)
          : [];
    if (JSON.stringify(actualSteps) !== JSON.stringify(fixture.expect.steps)) {
      errors.push(`Expected steps ${fixture.expect.steps.join(", ")}, got ${actualSteps.join(", ")}.`);
    }
  }

  return errors;
}

function createTrace(): CallerTrace {
  return {
    resolutions: [],
    events: [],
  };
}

function createReplayCaller(fixture: HarnessCallerFixture, trace: CallerTrace): Caller {
  return {
    resolve: async (request) => {
      const response = resolveHarnessRequest(request, fixture);
      (trace.resolutions as { request: ResolutionRequest; response?: ResolutionResponse }[]).push({
        request,
        response,
      });
      return response;
    },
    report: (event) => {
      (trace.events as ExecutionEvent[]).push(event);
    },
  };
}

function resolveHarnessRequest(
  request: ResolutionRequest,
  fixture: HarnessCallerFixture,
): ResolutionResponse | undefined {
  if (request.kind === "input") {
    const payload = Object.fromEntries(
      request.questions
        .filter((question) => fixture.answers?.[question.id] !== undefined)
        .map((question) => [question.id, fixture.answers?.[question.id]]),
    );
    return Object.keys(payload).length === 0 ? undefined : { actor: "human", payload };
  }
  if (request.kind === "approval") {
    const approved = fixture.approvals?.[request.gate.id];
    return approved === undefined ? undefined : { actor: "human", payload: approved };
  }
  const payload = fixture.answers?.[request.id];
  return payload === undefined ? undefined : { actor: "agent", payload };
}

type SkillReceipt = Extract<RunLocalSkillResult, { readonly status: "success" | "failure" }>["receipt"];

function skillReceipt(result: RunLocalSkillResult | RunLocalGraphResult): SkillReceipt | undefined {
  if ("receipt" in result && "skill" in result && !("chain" in result)) {
    return result.receipt as SkillReceipt | undefined;
  }
  return undefined;
}

function graphReceipt(result: RunLocalSkillResult | RunLocalGraphResult): Extract<RunLocalGraphResult, { readonly receipt: unknown }>["receipt"] | undefined {
  if ("receipt" in result && "graph" in result) {
    return result.receipt;
  }
  return undefined;
}

function validateCaller(value: Record<string, unknown>): HarnessCallerFixture {
  return {
    answers: optionalRecord(value.answers, "caller.answers"),
    approvals: validateApprovals(optionalRecord(value.approvals, "caller.approvals") ?? {}),
  };
}

function validateApprovals(value: Record<string, unknown>): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "boolean") {
        throw new Error(`caller.approvals.${key} must be a boolean.`);
      }
      return [key, entry];
    }),
  );
}

function validateExpectation(value: Record<string, unknown>): HarnessExpectation {
  return {
    status: optionalStatus(value.status, "expect.status"),
    receipt: validateReceiptExpectation(optionalRecord(value.receipt, "expect.receipt")),
    steps: optionalStringArray(value.steps, "expect.steps"),
  };
}

function validateReceiptExpectation(value: Record<string, unknown> | undefined): HarnessReceiptExpectation | undefined {
  if (!value) {
    return undefined;
  }
  return {
    kind: optionalReceiptKind(value.kind, "expect.receipt.kind"),
    status: optionalSuccessFailure(value.status, "expect.receipt.status"),
    skill_name: optionalString(value.skill_name, "expect.receipt.skill_name"),
    source_type: optionalString(value.source_type, "expect.receipt.source_type"),
    graph_name: optionalString(value.graph_name, "expect.receipt.graph_name"),
    owner: optionalString(value.owner, "expect.receipt.owner"),
  };
}

function validateEnv(value: Record<string, unknown>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string") {
        throw new Error(`env.${key} must be a string.`);
      }
      return [key, entry];
    }),
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function optionalStatus(value: unknown, field: string): HarnessExpectation["status"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "success" ||
    value === "failure" ||
    value === "needs_resolution" ||
    value === "policy_denied" ||
    value === "policy_denied"
  ) {
    return value;
  }
  throw new Error(`${field} must be success, failure, needs_resolution, or policy_denied.`);
}

function optionalSuccessFailure(value: unknown, field: string): "success" | "failure" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "success" || value === "failure") {
    return value;
  }
  throw new Error(`${field} must be success or failure.`);
}

function optionalReceiptKind(value: unknown, field: string): HarnessReceiptExpectation["kind"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "skill_execution" || value === "graph_execution") {
    return value;
  }
  throw new Error(`${field} must be skill_execution or graph_execution.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
