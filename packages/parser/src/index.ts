import { parseDocument } from "yaml";

import { validateGraphDocument, type ExecutionGraph } from "./graph.js";
import type { ExecutionSemantics } from "../../receipts/src/index.js";

export const parserPackage = "@runx/parser";

export interface RawSkillIR {
  readonly frontmatter: Record<string, unknown>;
  readonly rawFrontmatter: string;
  readonly body: string;
}

export interface SkillInput {
  readonly type: string;
  readonly required: boolean;
  readonly description?: string;
  readonly default?: unknown;
}

export interface SkillRetryPolicy {
  readonly maxAttempts: number;
}

export interface SkillIdempotencyPolicy {
  readonly key?: string;
}

export interface SkillSource {
  readonly type: string;
  readonly command?: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
  readonly inputMode?: "args" | "stdin" | "none";
  readonly sandbox?: SkillSandbox;
  readonly server?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  };
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly agentCardUrl?: string;
  readonly agentIdentity?: string;
  readonly agent?: string;
  readonly task?: string;
  readonly hook?: string;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly chain?: ExecutionGraph;
  readonly raw: Record<string, unknown>;
}

export interface SkillArtifactContract {
  readonly emits?: readonly string[];
  readonly namedEmits?: Readonly<Record<string, string>>;
  readonly wrapAs?: string;
}

export type SkillSandboxProfile = "readonly" | "workspace-write" | "network" | "unrestricted-local-dev";

export interface SkillSandbox {
  readonly profile: SkillSandboxProfile;
  readonly cwdPolicy?: "skill-directory" | "workspace" | "custom";
  readonly envAllowlist?: readonly string[];
  readonly network?: boolean;
  readonly writablePaths: readonly string[];
  readonly approvedEscalation?: boolean;
  readonly raw: Record<string, unknown>;
}

export interface ValidatedSkill {
  readonly name: string;
  readonly description?: string;
  readonly body: string;
  readonly source: SkillSource;
  readonly inputs: Readonly<Record<string, SkillInput>>;
  readonly auth?: unknown;
  readonly risk?: unknown;
  readonly runtime?: unknown;
  readonly retry?: SkillRetryPolicy;
  readonly idempotency?: SkillIdempotencyPolicy;
  readonly mutating?: boolean;
  readonly artifacts?: SkillArtifactContract;
  readonly allowedTools?: readonly string[];
  readonly execution?: ExecutionSemantics;
  readonly runx?: Record<string, unknown>;
  readonly raw: RawSkillIR;
}

export interface RawRunnerManifestIR {
  readonly document: Record<string, unknown>;
  readonly raw: string;
}

export interface RawToolManifestIR {
  readonly document: Record<string, unknown>;
  readonly raw: string;
}

export interface SkillRunnerDefinition {
  readonly name: string;
  readonly default: boolean;
  readonly source: SkillSource;
  readonly inputs: Readonly<Record<string, SkillInput>>;
  readonly auth?: unknown;
  readonly risk?: unknown;
  readonly runtime?: unknown;
  readonly retry?: SkillRetryPolicy;
  readonly idempotency?: SkillIdempotencyPolicy;
  readonly mutating?: boolean;
  readonly artifacts?: SkillArtifactContract;
  readonly allowedTools?: readonly string[];
  readonly execution?: ExecutionSemantics;
  readonly runx?: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

export type PostRunReflectPolicy = "auto" | "always" | "never";

export type CatalogKind = "skill" | "chain";
export type CatalogAudience = "public" | "builder" | "operator";
export type CatalogVisibility = "public" | "private";

export interface CatalogMetadata {
  readonly kind: CatalogKind;
  readonly audience: CatalogAudience;
  readonly visibility: CatalogVisibility;
}

export interface HarnessCallerFixture {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly approvals?: Readonly<Record<string, boolean>>;
}

export interface HarnessReceiptExpectation {
  readonly kind?: "skill_execution" | "graph_execution";
  readonly status?: "success" | "failure";
  readonly subject?: Readonly<Record<string, unknown>>;
}

export interface HarnessExpectation {
  readonly status?: "success" | "failure" | "needs_resolution" | "policy_denied";
  readonly receipt?: HarnessReceiptExpectation;
  readonly steps?: readonly string[];
}

export interface RunnerHarnessCase {
  readonly name: string;
  readonly runner?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string>>;
  readonly caller: HarnessCallerFixture;
  readonly expect: HarnessExpectation;
}

export interface RunnerHarnessManifest {
  readonly cases: readonly RunnerHarnessCase[];
}

export interface SkillRunnerManifest {
  readonly skill?: string;
  readonly catalog?: CatalogMetadata;
  readonly runners: Readonly<Record<string, SkillRunnerDefinition>>;
  readonly harness?: RunnerHarnessManifest;
  readonly raw: RawRunnerManifestIR;
}

export interface ValidatedTool {
  readonly name: string;
  readonly description?: string;
  readonly source: SkillSource;
  readonly inputs: Readonly<Record<string, SkillInput>>;
  readonly scopes: readonly string[];
  readonly risk?: unknown;
  readonly runtime?: unknown;
  readonly retry?: SkillRetryPolicy;
  readonly idempotency?: SkillIdempotencyPolicy;
  readonly mutating?: boolean;
  readonly artifacts?: SkillArtifactContract;
  readonly runx?: Record<string, unknown>;
  readonly raw: RawToolManifestIR;
}

export interface ValidateSkillOptions {
  readonly mode?: "strict" | "lenient";
}

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

export function parseSkillMarkdown(markdown: string): RawSkillIR {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new SkillParseError("Skill markdown must start with YAML frontmatter delimited by ---.");
  }

  const [, rawFrontmatter, body] = match;
  const document = parseDocument(rawFrontmatter, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new SkillParseError(document.errors.map((error) => error.message).join("; "));
  }

  const frontmatter = document.toJS();
  if (!isRecord(frontmatter)) {
    throw new SkillParseError("Skill frontmatter must parse to an object.");
  }

  return {
    frontmatter,
    rawFrontmatter,
    body,
  };
}

export function parseRunnerManifestYaml(yaml: string): RawRunnerManifestIR {
  const document = parseDocument(yaml, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new SkillParseError(document.errors.map((error) => error.message).join("; "));
  }

  const parsed = document.toJS();
  if (!isRecord(parsed)) {
    throw new SkillParseError("Runner manifest YAML must parse to an object.");
  }

  return {
    document: parsed,
    raw: yaml,
  };
}

export function parseToolManifestYaml(yaml: string): RawToolManifestIR {
  const document = parseDocument(yaml, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new SkillParseError(document.errors.map((error) => error.message).join("; "));
  }

  const parsed = document.toJS();
  if (!isRecord(parsed)) {
    throw new SkillParseError("Tool manifest YAML must parse to an object.");
  }

  return {
    document: parsed,
    raw: yaml,
  };
}

export function validateSkill(raw: RawSkillIR, options: ValidateSkillOptions = {}): ValidatedSkill {
  const mode = options.mode ?? "strict";
  const name = requiredString(raw.frontmatter.name, "name");
  const description = optionalString(raw.frontmatter.description, "description");
  const sourceRecord = optionalRecord(raw.frontmatter.source, "source");
  const inputs = validateInputs(optionalRecord(raw.frontmatter.inputs, "inputs") ?? {});
  const runxValue = raw.frontmatter.runx;

  if (mode === "strict" && runxValue !== undefined && !isRecord(runxValue)) {
    throw new SkillValidationError("runx must be an object when present.");
  }
  const source = validateSource(sourceRecord ?? { type: "agent" }, isRecord(runxValue) ? runxValue : undefined);
  const runx = isRecord(runxValue) ? runxValue : undefined;
  const risk = raw.frontmatter.risk;

  return {
    name,
    description,
    body: raw.body,
    source,
    inputs,
    auth: raw.frontmatter.auth,
    risk,
    runtime: raw.frontmatter.runtime,
    retry: validateSkillRetry(raw.frontmatter.retry ?? runx?.retry, "retry"),
    idempotency: validateSkillIdempotency(raw.frontmatter.idempotency ?? runx?.idempotency, "idempotency"),
    mutating: validateSkillMutation(raw.frontmatter.mutating ?? recordField(risk, "mutating") ?? runx?.mutating, "mutating"),
    artifacts: validateArtifactContract(recordField(runx, "artifacts"), "runx.artifacts"),
    allowedTools: validateAllowedTools(
      recordField(runx, "allowed_tools"),
      "runx.allowed_tools",
    ),
    execution: validateExecutionSemantics(raw.frontmatter.execution ?? recordField(runx, "execution"), "execution"),
    runx,
    raw,
  };
}

export function validateRunnerManifest(raw: RawRunnerManifestIR): SkillRunnerManifest {
  const runnersRecord = requiredRecord(raw.document.runners, "runners");
  const runners: Record<string, SkillRunnerDefinition> = {};

  for (const [name, value] of Object.entries(runnersRecord)) {
    const runner = requiredRecord(value, `runners.${name}`);
    const runx = optionalRecord(runner.runx, `runners.${name}.runx`);
    validatePostRunReflectPolicy(runx, `runners.${name}.runx`);
    const sourceRecord = optionalRecord(runner.source, `runners.${name}.source`) ?? runner;
    const risk = runner.risk;
    runners[name] = {
      name,
      default: optionalBoolean(runner.default, `runners.${name}.default`) ?? false,
      source: validateSource(sourceRecord, runx),
      inputs: validateInputs(optionalRecord(runner.inputs, `runners.${name}.inputs`) ?? {}),
      auth: runner.auth,
      risk,
      runtime: runner.runtime,
      retry: validateSkillRetry(runner.retry ?? runx?.retry, `runners.${name}.retry`),
      idempotency: validateSkillIdempotency(runner.idempotency ?? runx?.idempotency, `runners.${name}.idempotency`),
      mutating: validateSkillMutation(runner.mutating ?? recordField(risk, "mutating") ?? runx?.mutating, `runners.${name}.mutating`),
      artifacts: validateArtifactContract(
        recordField(runner, "artifacts") ?? recordField(runx, "artifacts"),
        `runners.${name}.artifacts`,
      ),
      allowedTools: validateAllowedTools(
        recordField(runx, "allowed_tools"),
        `runners.${name}.runx.allowed_tools`,
      ),
      execution: validateExecutionSemantics(runner.execution ?? recordField(runx, "execution"), `runners.${name}.execution`),
      runx,
      raw: runner,
    };
  }

  const harness = validateHarnessManifest(optionalRecord(raw.document.harness, "harness"), "harness");
  for (const entry of harness?.cases ?? []) {
    if (entry.runner && !runners[entry.runner]) {
      throw new SkillValidationError(`harness.cases runner ${entry.runner} is not declared in runners.`);
    }
  }

  return {
    skill: optionalString(raw.document.skill, "skill"),
    catalog: validateCatalogMetadata(optionalRecord(raw.document.catalog, "catalog"), "catalog"),
    runners,
    harness,
    raw,
  };
}

function validateCatalogMetadata(value: Record<string, unknown> | undefined, label: string): CatalogMetadata | undefined {
  if (!value) {
    return undefined;
  }
  const kind = requiredString(value.kind, `${label}.kind`);
  const audience = requiredString(value.audience, `${label}.audience`);
  const visibility = optionalString(value.visibility, `${label}.visibility`) ?? "public";

  if (kind !== "skill" && kind !== "chain") {
    throw new SkillValidationError(`${label}.kind must be skill or chain.`);
  }
  if (audience !== "public" && audience !== "builder" && audience !== "operator") {
    throw new SkillValidationError(`${label}.audience must be public, builder, or operator.`);
  }
  if (visibility !== "public" && visibility !== "private") {
    throw new SkillValidationError(`${label}.visibility must be public or private.`);
  }

  return {
    kind,
    audience,
    visibility,
  };
}

export function validateToolManifest(raw: RawToolManifestIR): ValidatedTool {
  const name = requiredString(raw.document.name, "name");
  const description = optionalString(raw.document.description, "description");
  const runx = optionalRecord(raw.document.runx, "runx");
  const risk = raw.document.risk;
  const source = validateToolSource(validateSource(requiredRecord(raw.document.source, "source"), runx), "source.type");

  return {
    name,
    description,
    source,
    inputs: validateInputs(optionalRecord(raw.document.inputs, "inputs") ?? {}),
    scopes: optionalStringArray(raw.document.scopes, "scopes") ?? [],
    risk,
    runtime: raw.document.runtime,
    retry: validateSkillRetry(raw.document.retry ?? runx?.retry, "retry"),
    idempotency: validateSkillIdempotency(raw.document.idempotency ?? runx?.idempotency, "idempotency"),
    mutating: validateSkillMutation(
      raw.document.mutating ?? recordField(risk, "mutating") ?? runx?.mutating,
      "mutating",
    ),
    artifacts: validateArtifactContract(recordField(runx, "artifacts"), "runx.artifacts"),
    runx,
    raw,
  };
}

export function validateSkillSource(
  source: Record<string, unknown>,
  runx?: Record<string, unknown>,
): SkillSource {
  return validateSource(source, runx);
}

export function validateSkillArtifactContract(
  value: unknown,
  field = "artifacts",
): SkillArtifactContract | undefined {
  return validateArtifactContract(value, field);
}

export function resolvePostRunReflectPolicy(
  runx: Record<string, unknown> | undefined,
  field = "runx",
): PostRunReflectPolicy {
  const postRun = optionalRecord(recordField(runx, "post_run"), `${field}.post_run`);
  const reflect = optionalString(recordField(postRun, "reflect"), `${field}.post_run.reflect`) ?? "never";
  if (reflect !== "auto" && reflect !== "always" && reflect !== "never") {
    throw new SkillValidationError(`${field}.post_run.reflect must be auto, always, or never.`);
  }
  return reflect;
}

function validateSource(source: Record<string, unknown>, runx: Record<string, unknown> | undefined): SkillSource {
  const type = requiredString(source.type, "source.type");
  const args = optionalStringArray(source.args, "source.args") ?? [];
  const inputMode = optionalInputMode(source.input_mode);
  const timeoutSeconds = optionalNumber(source.timeout_seconds, "source.timeout_seconds");
  const cwd = optionalString(source.cwd, "source.cwd");

  if (type === "cli-tool") {
    requiredString(source.command, "source.command");
  }

  const mcpServer = type === "mcp" ? validateMcpServer(source.server) : undefined;
  const mcpTool = type === "mcp" ? requiredString(source.tool, "source.tool") : optionalString(source.tool, "source.tool");
  const mcpArguments = optionalRecord(source.arguments, "source.arguments");
  const a2aAgentCardUrl =
    type === "a2a"
      ? requiredString(source.agent_card_url, "source.agent_card_url")
      : optionalString(source.agent_card_url, "source.agent_card_url");
  const a2aAgentIdentity = optionalString(source.agent_identity, "source.agent_identity");
  const agent = type === "agent-step" ? requiredString(source.agent, "source.agent") : optionalString(source.agent, "source.agent");
  const task =
    type === "agent-step" || type === "a2a"
      ? requiredString(source.task, "source.task")
      : optionalString(source.task, "source.task");
  const hook =
    type === "harness-hook" ? requiredString(source.hook, "source.hook") : optionalString(source.hook, "source.hook");
  const outputs = optionalRecord(source.outputs, "source.outputs");
  const chain = type === "chain" ? validateChainSource(source.chain) : undefined;
  const sandbox = validateSandbox(source.sandbox ?? runx?.sandbox);

  if ((type === "agent-step" || type === "harness-hook") && (source.command !== undefined || source.args !== undefined)) {
    throw new SkillValidationError(`${type} sources must not declare source.command or source.args.`);
  }

  return {
    type,
    command: optionalString(source.command, "source.command"),
    args,
    cwd,
    timeoutSeconds,
    inputMode,
    sandbox,
    server: mcpServer,
    tool: mcpTool,
    arguments: mcpArguments,
    agentCardUrl: a2aAgentCardUrl,
    agentIdentity: a2aAgentIdentity,
    agent,
    task,
    hook,
    outputs,
    chain,
    raw: source,
  };
}

function validateChainSource(value: unknown): ExecutionGraph {
  const chain = requiredRecord(value, "source.chain");
  return validateGraphDocument(chain);
}

function validateToolSource(source: SkillSource, field: string): SkillSource {
  if (!["cli-tool", "mcp", "a2a"].includes(source.type)) {
    throw new SkillValidationError(`${field} must be one of cli-tool, mcp, or a2a for tool manifests.`);
  }
  return source;
}

function validateSandbox(value: unknown): SkillSandbox | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requiredRecord(value, "sandbox");
  const profile = requiredSandboxProfile(record.profile, "sandbox.profile");
  return {
    profile,
    cwdPolicy: optionalCwdPolicy(record.cwd_policy),
    envAllowlist: optionalStringArray(record.env_allowlist, "sandbox.env_allowlist"),
    network: optionalBoolean(record.network, "sandbox.network"),
    writablePaths: optionalStringArray(record.writable_paths, "sandbox.writable_paths") ?? [],
    raw: record,
  };
}

function validateMcpServer(value: unknown): SkillSource["server"] {
  const server = requiredRecord(value, "source.server");
  return {
    command: requiredString(server.command, "source.server.command"),
    args: optionalStringArray(server.args, "source.server.args") ?? [],
    cwd: optionalString(server.cwd, "source.server.cwd"),
  };
}

function validateInputs(inputs: Record<string, unknown>): Readonly<Record<string, SkillInput>> {
  const validated: Record<string, SkillInput> = {};

  for (const [name, input] of Object.entries(inputs)) {
    if (!isRecord(input)) {
      throw new SkillValidationError(`inputs.${name} must be an object.`);
    }

    validated[name] = {
      type: optionalString(input.type, `inputs.${name}.type`) ?? "string",
      required: optionalBoolean(input.required, `inputs.${name}.required`) ?? false,
      description: optionalString(input.description, `inputs.${name}.description`),
      default: input.default,
    };
  }

  return validated;
}

function validateExecutionSemantics(value: unknown, field: string): ExecutionSemantics | undefined {
  const record = optionalRecord(value, field);
  if (!record) {
    return undefined;
  }

  return {
    disposition: optionalDisposition(record.disposition, `${field}.disposition`),
    outcome_state: optionalOutcomeState(record.outcome_state, `${field}.outcome_state`),
    outcome: validateOutcome(record.outcome, `${field}.outcome`),
    input_context: validateInputContext(record.input_context, `${field}.input_context`),
    surface_refs: validateSurfaceRefs(record.surface_refs, `${field}.surface_refs`),
    evidence_refs: validateSurfaceRefs(record.evidence_refs, `${field}.evidence_refs`),
  };
}

function validateOutcome(value: unknown, field: string): ExecutionSemantics["outcome"] {
  const record = optionalRecord(value, field);
  if (!record) {
    return undefined;
  }
  return {
    code: optionalString(record.code, `${field}.code`),
    summary: optionalString(record.summary, `${field}.summary`),
    observed_at: optionalString(record.observed_at, `${field}.observed_at`),
    data: optionalRecord(record.data, `${field}.data`),
  };
}

function validateInputContext(value: unknown, field: string): ExecutionSemantics["input_context"] {
  const record = optionalRecord(value, field);
  if (!record) {
    return undefined;
  }
  const maxBytes = optionalNumber(record.max_bytes, `${field}.max_bytes`);
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new SkillValidationError(`${field}.max_bytes must be a positive integer.`);
  }
  return {
    capture: optionalBoolean(record.capture, `${field}.capture`),
    source: optionalString(record.source, `${field}.source`),
    max_bytes: maxBytes,
    snapshot: record.snapshot,
  };
}

function validateSurfaceRefs(value: unknown, field: string): ExecutionSemantics["surface_refs"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new SkillValidationError(`${field} must be an array when present.`);
  }

  return value.map((entry, index) => {
    const record = requiredRecord(entry, `${field}[${index}]`);
    return {
      type: requiredString(record.type, `${field}[${index}].type`),
      uri: requiredString(record.uri, `${field}[${index}].uri`),
      label: optionalString(record.label, `${field}[${index}].label`),
    };
  });
}

function optionalDisposition(value: unknown, field: string): ExecutionSemantics["disposition"] {
  const disposition = optionalString(value, field);
  if (disposition === undefined) {
    return undefined;
  }
  if (!["completed", "needs_resolution", "policy_denied", "approval_required", "observing"].includes(disposition)) {
    throw new SkillValidationError(
      `${field} must be one of completed, needs_resolution, policy_denied, approval_required, or observing.`,
    );
  }
  return disposition as ExecutionSemantics["disposition"];
}

function optionalOutcomeState(value: unknown, field: string): ExecutionSemantics["outcome_state"] {
  const outcomeState = optionalString(value, field);
  if (outcomeState === undefined) {
    return undefined;
  }
  if (!["pending", "complete", "expired"].includes(outcomeState)) {
    throw new SkillValidationError(`${field} must be one of pending, complete, or expired.`);
  }
  return outcomeState as ExecutionSemantics["outcome_state"];
}

function validateSkillRetry(value: unknown, field: string): SkillRetryPolicy | undefined {
  const retry = optionalRecord(value, field);
  if (!retry) {
    return undefined;
  }
  const maxAttempts = optionalNumber(retry.max_attempts, `${field}.max_attempts`) ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new SkillValidationError(`${field}.max_attempts must be a positive integer.`);
  }
  return { maxAttempts };
}

function validateSkillIdempotency(value: unknown, field: string): SkillIdempotencyPolicy | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new SkillValidationError(`${field} must not be empty.`);
    }
    return { key: value };
  }
  const record = requiredRecord(value, field);
  const key = optionalNonEmptyString(record.key, `${field}.key`);
  return { key };
}

function validateSkillMutation(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new SkillValidationError(`${field} must be a boolean.`);
}

function validateArtifactContract(value: unknown, field: string): SkillArtifactContract | undefined {
  const record = optionalRecord(value, field);
  if (!record) {
    return undefined;
  }
  const emitsValue = record.emits;
  const emits =
    typeof emitsValue === "string"
      ? [emitsValue]
      : optionalStringArray(emitsValue, `${field}.emits`);
  const namedEmits = validateNamedEmits(record.named_emits ?? record.namedEmits, `${field}.named_emits`);
  const wrapAs = optionalNonEmptyString(record.wrap_as ?? record.wrapAs, `${field}.wrap_as`);
  if (!emits && !namedEmits && !wrapAs) {
    return undefined;
  }
  return {
    emits,
    namedEmits,
    wrapAs,
  };
}

function validateAllowedTools(value: unknown, field: string): readonly string[] | undefined {
  const allowedTools = optionalStringArray(value, field);
  if (!allowedTools) {
    return undefined;
  }
  return allowedTools.map((entry) => {
    if (entry.trim() === "") {
      throw new SkillValidationError(`${field} entries must not be empty.`);
    }
    return entry;
  });
}

function validatePostRunReflectPolicy(
  runx: Record<string, unknown> | undefined,
  field: string,
): void {
  void resolvePostRunReflectPolicy(runx, field);
}

function validateNamedEmits(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  const record = optionalRecord(value, field);
  if (!record) {
    return undefined;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new SkillValidationError(`${field}.${key} must be a non-empty string.`);
    }
  }
  return record as Readonly<Record<string, string>>;
}

function validateHarnessManifest(value: Record<string, unknown> | undefined, field: string): RunnerHarnessManifest | undefined {
  if (!value) {
    return undefined;
  }
  const casesValue = value.cases;
  if (!Array.isArray(casesValue)) {
    throw new SkillValidationError(`${field}.cases must be an array.`);
  }
  return {
    cases: casesValue.map((entry, index) =>
      validateHarnessCase(requiredRecord(entry, `${field}.cases[${index}]`), `${field}.cases[${index}]`),
    ),
  };
}

function validateHarnessCase(value: Record<string, unknown>, field: string): RunnerHarnessCase {
  return {
    name: requiredString(value.name, `${field}.name`),
    runner: optionalNonEmptyString(value.runner, `${field}.runner`),
    inputs: optionalRecord(value.inputs, `${field}.inputs`) ?? {},
    env: validateHarnessEnv(optionalRecord(value.env, `${field}.env`) ?? {}, `${field}.env`),
    caller: validateHarnessCaller(optionalRecord(value.caller, `${field}.caller`) ?? {}, `${field}.caller`),
    expect: validateHarnessExpectation(requiredRecord(value.expect, `${field}.expect`), `${field}.expect`),
  };
}

function validateHarnessCaller(value: Record<string, unknown>, field: string): HarnessCallerFixture {
  return {
    answers: optionalRecord(value.answers, `${field}.answers`),
    approvals: validateHarnessApprovals(optionalRecord(value.approvals, `${field}.approvals`) ?? {}, `${field}.approvals`),
  };
}

function validateHarnessExpectation(value: Record<string, unknown>, field: string): HarnessExpectation {
  return {
    status: optionalHarnessStatus(value.status, `${field}.status`),
    receipt: validateHarnessReceiptExpectation(optionalRecord(value.receipt, `${field}.receipt`), `${field}.receipt`),
    steps: optionalStringArray(value.steps, `${field}.steps`),
  };
}

function validateHarnessReceiptExpectation(
  value: Record<string, unknown> | undefined,
  field: string,
): HarnessReceiptExpectation | undefined {
  if (!value) {
    return undefined;
  }
  return {
    kind: optionalHarnessReceiptKind(value.kind, `${field}.kind`),
    status: optionalHarnessReceiptStatus(value.status, `${field}.status`),
    subject: optionalRecord(value.subject, `${field}.subject`),
  };
}

function validateHarnessEnv(value: Record<string, unknown>, field: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string") {
        throw new SkillValidationError(`${field}.${key} must be a string.`);
      }
      return [key, entry];
    }),
  );
}

function validateHarnessApprovals(value: Record<string, unknown>, field: string): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "boolean") {
        throw new SkillValidationError(`${field}.${key} must be a boolean.`);
      }
      return [key, entry];
    }),
  );
}

function optionalHarnessStatus(value: unknown, field: string): HarnessExpectation["status"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "success" ||
    value === "failure" ||
    value === "needs_resolution" ||
    value === "policy_denied"
  ) {
    return value;
  }
  throw new SkillValidationError(`${field} must be success, failure, needs_resolution, or policy_denied.`);
}

function optionalHarnessReceiptStatus(value: unknown, field: string): HarnessReceiptExpectation["status"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "success" || value === "failure") {
    return value;
  }
  throw new SkillValidationError(`${field} must be success or failure.`);
}

function optionalHarnessReceiptKind(value: unknown, field: string): HarnessReceiptExpectation["kind"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "skill_execution" || value === "graph_execution") {
    return value;
  }
  throw new SkillValidationError(`${field} must be skill_execution or graph_execution.`);
}

function requiredString(value: unknown, field: string): string {
  const stringValue = optionalString(value, field);
  if (!stringValue) {
    throw new SkillValidationError(`${field} is required.`);
  }
  return stringValue;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SkillValidationError(`${field} must be a string.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  const stringValue = optionalString(value, field);
  if (stringValue !== undefined && stringValue.trim() === "") {
    throw new SkillValidationError(`${field} must not be empty.`);
  }
  return stringValue;
}

function recordField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  const record = optionalRecord(value, field);
  if (!record) {
    throw new SkillValidationError(`${field} is required.`);
  }
  return record;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new SkillValidationError(`${field} must be an object.`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SkillValidationError(`${field} must be an array of strings.`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SkillValidationError(`${field} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new SkillValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function optionalInputMode(value: unknown): SkillSource["inputMode"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "args" || value === "stdin" || value === "none") {
    return value;
  }
  throw new SkillValidationError("source.input_mode must be args, stdin, or none.");
}

function requiredSandboxProfile(value: unknown, field: string): SkillSandboxProfile {
  const profile = requiredString(value, field);
  if (profile === "readonly" || profile === "workspace-write" || profile === "network" || profile === "unrestricted-local-dev") {
    return profile;
  }
  throw new SkillValidationError(`${field} must be readonly, workspace-write, network, or unrestricted-local-dev.`);
}

function optionalCwdPolicy(value: unknown): SkillSandbox["cwdPolicy"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "skill-directory" || value === "workspace" || value === "custom") {
    return value;
  }
  throw new SkillValidationError("sandbox.cwd_policy must be skill-directory, workspace, or custom.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./graph.js";
export * from "./install.js";
