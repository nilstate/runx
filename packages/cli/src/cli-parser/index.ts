import { parseDocument } from "yaml";

import { validateGraphDocument, type ExecutionGraph } from "./graph.js";
import {
  assertExecutionProfileYamlSubset,
  assertYamlParitySubset,
  YamlSubsetError,
} from "./yaml-subset.js";
import { normalizeSandboxDeclaration } from "../cli-sandbox.js";
import { GOVERNED_DISPOSITIONS, type ExecutionSemantics } from "../cli-execution-semantics.js";
import { errorMessage, isRecord, readField } from "../cli-util.js";

export * from "./install.js";

export const parserPackage = "@runxhq/cli/parser";

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
  readonly catalogRef?: string;
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly agentCardUrl?: string;
  readonly agentIdentity?: string;
  readonly agent?: string;
  readonly task?: string;
  readonly hook?: string;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly graph?: ExecutionGraph;
  readonly http?: SkillHttpSource;
  readonly act?: ActDeclaration;
  readonly raw: Record<string, unknown>;
}

export interface SkillHttpSource {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowPrivateNetwork?: boolean;
}

export interface ActDeclaration {
  readonly form?: string;
  readonly form_from?: string;
  readonly purpose?: string;
  readonly purpose_from?: string;
  readonly legitimacy?: string;
  readonly legitimacy_from?: string;
  readonly reason_from?: string;
  readonly target_from?: string;
  readonly decision_from?: string;
  readonly effect_from?: string;
  readonly effect_field_from?: string;
  readonly effect_from_input?: string;
  readonly effect_type?: string;
  readonly effect_prefix?: string;
  readonly effect_prefix_from?: string;
  readonly actor_from?: string;
  readonly authority_from?: string;
  readonly authority_term_from?: string;
  readonly authority_parent_from?: string;
  readonly authority_subset_proof_from?: string;
  readonly mint_authority?: MintAuthorityDirective;
  readonly requested_scope_from?: string;
  readonly previous_from?: string;
  readonly reason_step?: string;
  readonly effect_step?: string;
}

export type MintScopeSource = "static_scopes" | "requested_scope";

export interface MintAuthorityDirective {
  readonly source: MintScopeSource;
}

export interface SkillArtifactContract {
  readonly emits?: readonly string[];
  readonly namedEmits?: Readonly<Record<string, string>>;
  readonly wrapAs?: string;
}

export interface SkillQualityProfile {
  readonly heading: "Quality Profile";
  readonly content: string;
}

export type SkillSandboxProfile = "readonly" | "workspace-write" | "network" | "unrestricted-local-dev";

export interface SkillSandbox {
  readonly profile: SkillSandboxProfile;
  readonly cwdPolicy?: "skill-directory" | "workspace" | "custom";
  readonly envAllowlist?: readonly string[];
  readonly network?: boolean;
  readonly writablePaths: readonly string[];
  readonly requireEnforcement?: boolean;
  readonly approvedEscalation?: boolean;
  readonly raw: Record<string, unknown>;
}

export interface ValidatedSkill {
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly runxCategory?: string;
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
  readonly qualityProfile?: SkillQualityProfile;
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

export type CatalogKind = "skill" | "graph";
export type CatalogAudience = "public" | "builder" | "operator" | "system";
export type CatalogVisibility = "public" | "internal";
export type CatalogRole =
  | "canonical"
  | "branded"
  | "context"
  | "graph-stage"
  | "runtime-path"
  | "harness-fixture";

export interface CatalogMetadata {
  readonly kind: CatalogKind;
  readonly audience: CatalogAudience;
  readonly visibility: CatalogVisibility;
  readonly role: CatalogRole;
  readonly canonicalSkill?: string;
  readonly provider?: string;
  readonly runtimePath?: string;
  readonly partOf?: readonly string[];
}

export interface HarnessCallerFixture {
  readonly answers?: Readonly<Record<string, unknown>>;
  readonly approvals?: Readonly<Record<string, boolean>>;
}

export interface ReceiptExpectation {
  readonly [key: string]: unknown;
  readonly schema?: "runx.receipt.v1";
  readonly status?: "sealed" | "failure";
  readonly source_type?: string;
  readonly body_digest?: string;
  readonly receipt_digest?: string;
  readonly harness_id?: string;
  readonly state?: string;
  readonly disposition?: string;
  readonly reason_code?: string;
  readonly child_receipt_refs?: readonly string[];
  readonly act_ids?: readonly string[];
  readonly owner?: string;
}

export interface HarnessExpectation {
  readonly status?: "sealed" | "failure" | "needs_agent" | "policy_denied" | "escalated";
  readonly receipt?: ReceiptExpectation;
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
  readonly version?: string;
  readonly runx?: Readonly<Record<string, unknown>>;
  readonly policy?: unknown;
  readonly emits?: unknown;
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillParseError";
  }
}

export class SkillValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
  assertYamlSubset("runner_manifest", yaml, "execution-profile");
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
  assertYamlSubset("tool_manifest", yaml, "parity");
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

export function parseToolManifestJson(json: string): RawToolManifestIR {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SkillParseError(
      `Tool manifest JSON is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new SkillParseError("Tool manifest JSON must parse to an object.");
  }

  return {
    document: parsed,
    raw: json,
  };
}

export function validateSkill(raw: RawSkillIR, options: ValidateSkillOptions = {}): ValidatedSkill {
  const mode = options.mode ?? "strict";
  const name = requiredNullableString(raw.frontmatter.name, "name");
  const description = optionalNullableString(raw.frontmatter.description, "description");
  const sourceRecord = optionalNullableRecord(raw.frontmatter.source, "source");
  const inputs = validateInputs(optionalNullableRecord(raw.frontmatter.inputs, "inputs") ?? {});
  const runxValue = raw.frontmatter.runx;

  if (mode === "strict" && runxValue !== undefined && !isRecord(runxValue)) {
    throw new SkillValidationError("runx must be an object when present.");
  }
  const source = validateSource(sourceRecord ?? { type: "agent" }, isRecord(runxValue) ? runxValue : undefined);
  const runx = isRecord(runxValue) ? runxValue : undefined;
  const category = validatePortableSkillCategory(raw.frontmatter.category);
  const runxCategory = validateRunxSkillCategory(readField(runx, "category"));
  const risk = raw.frontmatter.risk;

  return {
    name,
    description,
    category,
    runxCategory,
    body: raw.body,
    source,
    inputs,
    auth: raw.frontmatter.auth,
    risk,
    runtime: raw.frontmatter.runtime,
    retry: validateSkillRetry(raw.frontmatter.retry ?? runx?.retry, "retry"),
    idempotency: validateSkillIdempotency(raw.frontmatter.idempotency ?? runx?.idempotency, "idempotency"),
    mutating: validateSkillMutation(raw.frontmatter.mutating ?? readField(risk, "mutating") ?? runx?.mutating, "mutating"),
    artifacts: validateArtifactContract(readField(runx, "artifacts"), "runx.artifacts"),
    qualityProfile: extractSkillQualityProfile(raw.body),
    allowedTools: validateAllowedTools(
      readField(runx, "allowed_tools"),
      "runx.allowed_tools",
    ),
    execution: validateExecutionSemantics(raw.frontmatter.execution ?? readField(runx, "execution"), "execution"),
    runx,
    raw,
  };
}

function validatePortableSkillCategory(value: unknown): string | undefined {
  return normalizeOptionalCategory(optionalNullableString(value, "category"));
}

function validateRunxSkillCategory(value: unknown): string | undefined {
  return normalizeOptionalCategory(optionalNullableString(value, "runx.category"));
}

function normalizeOptionalCategory(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function extractSkillQualityProfile(body: string): SkillQualityProfile | undefined {
  const content = extractMarkdownSection(body, "Quality Profile", 2);
  if (!content) {
    return undefined;
  }
  return {
    heading: "Quality Profile",
    content,
  };
}

export function validateRunnerManifest(raw: RawRunnerManifestIR): SkillRunnerManifest {
  const runnersRecord = requiredNullableRecord(raw.document.runners, "runners");
  rejectUnknownFields(raw.document, "runner_manifest", ["skill", "version", "runx", "policy", "emits", "catalog", "runners", "harness"]);
  const runners: Record<string, SkillRunnerDefinition> = {};

  for (const [name, value] of Object.entries(runnersRecord)) {
    const runner = requiredNullableRecord(value, `runners.${name}`);
    rejectUnknownFields(runner, `runners.${name}`, runnerFields);
    const runx = optionalNullableRecord(runner.runx, `runners.${name}.runx`);
    validatePostRunReflectPolicy(runx, `runners.${name}.runx`);
    const sourceRecord = optionalNullableRecord(runner.source, `runners.${name}.source`) ?? runner;
    if (runner.source !== undefined) {
      rejectUnknownFields(sourceRecord, `runners.${name}.source`, sourceFields);
    }
    const risk = runner.risk;
    runners[name] = {
      name,
      default: optionalNullableBoolean(runner.default, `runners.${name}.default`) ?? false,
      source: validateSource(sourceRecord, runx),
      inputs: validateInputs(optionalNullableRecord(runner.inputs, `runners.${name}.inputs`) ?? {}),
      auth: runner.auth,
      risk,
      runtime: runner.runtime,
      retry: validateSkillRetry(runner.retry ?? runx?.retry, `runners.${name}.retry`),
      idempotency: validateSkillIdempotency(runner.idempotency ?? runx?.idempotency, `runners.${name}.idempotency`),
      mutating: validateSkillMutation(runner.mutating ?? readField(risk, "mutating") ?? runx?.mutating, `runners.${name}.mutating`),
      artifacts: validateArtifactContract(
        readField(runner, "artifacts") ?? readField(runx, "artifacts"),
        `runners.${name}.artifacts`,
      ),
      allowedTools: validateAllowedTools(
        readField(runx, "allowed_tools"),
        `runners.${name}.runx.allowed_tools`,
      ),
      execution: validateExecutionSemantics(runner.execution ?? readField(runx, "execution"), `runners.${name}.execution`),
      runx,
      raw: runner,
    };
  }

  const harness = validateHarnessManifest(optionalNullableRecord(raw.document.harness, "harness"), "harness");
  for (const entry of harness?.cases ?? []) {
    if (entry.runner && !runners[entry.runner]) {
      throw new SkillValidationError(`harness.cases runner ${entry.runner} is not declared in runners.`);
    }
  }

  return {
    skill: optionalNullableString(raw.document.skill, "skill"),
    version: optionalNullableString(raw.document.version, "version"),
    runx: optionalNullableRecord(raw.document.runx, "runx"),
    policy: raw.document.policy,
    emits: raw.document.emits,
    catalog: validateCatalogMetadata(optionalNullableRecord(raw.document.catalog, "catalog"), "catalog"),
    runners,
    harness,
    raw,
  };
}

function validateCatalogMetadata(value: Record<string, unknown> | undefined, label: string): CatalogMetadata | undefined {
  if (!value) {
    return undefined;
  }
  const kind = requiredNullableString(value.kind, `${label}.kind`);
  const audience = requiredNullableString(value.audience, `${label}.audience`);
  const visibility = optionalNullableString(value.visibility, `${label}.visibility`) ?? "public";
  const role = requiredNullableString(value.role, `${label}.role`);
  const canonicalSkill = optionalNullableString(value.canonical_skill, `${label}.canonical_skill`);
  const provider = optionalNullableString(value.provider, `${label}.provider`);
  const runtimePath = optionalNullableString(value.runtime_path, `${label}.runtime_path`);
  const partOf = optionalNullableStringArray(value.part_of, `${label}.part_of`);

  if (kind !== "skill" && kind !== "graph") {
    throw new SkillValidationError(`${label}.kind must be skill or graph.`);
  }
  if (audience !== "public" && audience !== "builder" && audience !== "operator" && audience !== "system") {
    throw new SkillValidationError(`${label}.audience must be public, builder, operator, or system.`);
  }
  if (visibility !== "public" && visibility !== "internal") {
    throw new SkillValidationError(`${label}.visibility must be public or internal.`);
  }
  if (
    role !== "canonical" &&
    role !== "branded" &&
    role !== "context" &&
    role !== "graph-stage" &&
    role !== "runtime-path" &&
    role !== "harness-fixture"
  ) {
    throw new SkillValidationError(
      `${label}.role must be canonical, branded, context, graph-stage, runtime-path, or harness-fixture.`,
    );
  }
  if (visibility === "public" && !["canonical", "branded", "context"].includes(role)) {
    throw new SkillValidationError(`${label}.role cannot be ${role} when visibility is public.`);
  }
  if (role === "branded") {
    if (!canonicalSkill) {
      throw new SkillValidationError(`${label}.canonical_skill is required when catalog.role is branded.`);
    }
    if (!provider) {
      throw new SkillValidationError(`${label}.provider is required when catalog.role is branded.`);
    }
  }
  if ((role === "graph-stage" || role === "runtime-path" || role === "harness-fixture") && !partOf?.length) {
    throw new SkillValidationError(`${label}.part_of is required when catalog.role is ${role}.`);
  }

  return {
    kind,
    audience,
    visibility,
    role,
    canonicalSkill,
    provider,
    runtimePath,
    partOf,
  };
}

function extractMarkdownSection(body: string, heading: string, level: number): string | undefined {
  const lines = body.split(/\r?\n/);
  const headingPattern = new RegExp(`^#{${level}}\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const boundaryPattern = new RegExp(`^#{1,${level}}\\s+\\S+`);
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) {
    return undefined;
  }

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (boundaryPattern.test(line.trim())) {
      break;
    }
    collected.push(line);
  }

  const content = trimBlankLines(collected).join("\n").trim();
  return content.length > 0 ? content : undefined;
}

function trimBlankLines(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") {
    start++;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end--;
  }
  return lines.slice(start, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateToolManifest(raw: RawToolManifestIR): ValidatedTool {
  const name = requiredNullableString(raw.document.name, "name");
  const description = optionalNullableString(raw.document.description, "description");
  const runx = optionalNullableRecord(raw.document.runx, "runx");
  const risk = raw.document.risk;
  const source = validateToolSource(validateSource(requiredNullableRecord(raw.document.source, "source"), runx), "source.type");

  return {
    name,
    description,
    source,
    inputs: validateInputs(optionalNullableRecord(raw.document.inputs, "inputs") ?? {}),
    scopes: optionalNullableStringArray(raw.document.scopes, "scopes") ?? [],
    risk,
    runtime: raw.document.runtime,
    retry: validateSkillRetry(raw.document.retry ?? runx?.retry, "retry"),
    idempotency: validateSkillIdempotency(raw.document.idempotency ?? runx?.idempotency, "idempotency"),
    mutating: validateSkillMutation(
      raw.document.mutating ?? readField(risk, "mutating") ?? runx?.mutating,
      "mutating",
    ),
    artifacts: validateArtifactContract(readField(runx, "artifacts"), "runx.artifacts"),
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
  const postRun = optionalNullableRecord(readField(runx, "post_run"), `${field}.post_run`);
  const reflect = optionalNullableString(readField(postRun, "reflect"), `${field}.post_run.reflect`) ?? "never";
  if (reflect !== "auto" && reflect !== "always" && reflect !== "never") {
    throw new SkillValidationError(`${field}.post_run.reflect must be auto, always, or never.`);
  }
  return reflect;
}

function validateSource(source: Record<string, unknown>, runx: Record<string, unknown> | undefined): SkillSource {
  const type = requiredNullableString(source.type, "source.type");
  validateSourceType(type, "source.type");
  const args = optionalNullableStringArray(source.args, "source.args") ?? [];
  const inputMode = optionalInputMode(source.input_mode);
  const timeoutSeconds = optionalNullableNumber(source.timeout_seconds, "source.timeout_seconds");
  const cwd = optionalNullableString(source.cwd, "source.cwd");

  if (type === "cli-tool") {
    requiredNullableString(source.command, "source.command");
  }

  const mcpServer = type === "mcp" ? validateMcpServer(source.server) : undefined;
  const mcpTool = type === "mcp" ? requiredNullableString(source.tool, "source.tool") : optionalNullableString(source.tool, "source.tool");
  const mcpArguments = optionalNullableRecord(source.arguments, "source.arguments");
  const catalogRef = type === "catalog"
    ? requiredNullableString(source.catalog_ref, "source.catalog_ref")
    : optionalNullableString(source.catalog_ref, "source.catalog_ref");
  const a2aAgentCardUrl =
    type === "a2a"
      ? requiredNullableString(source.agent_card_url, "source.agent_card_url")
      : optionalNullableString(source.agent_card_url, "source.agent_card_url");
  const a2aAgentIdentity = optionalNullableString(source.agent_identity, "source.agent_identity");
  const agent = type === "agent-task" ? requiredNullableString(source.agent, "source.agent") : optionalNullableString(source.agent, "source.agent");
  const task =
    type === "agent-task" || type === "a2a"
      ? requiredNullableString(source.task, "source.task")
      : optionalNullableString(source.task, "source.task");
  const hook =
    type === "harness-hook" ? requiredNullableString(source.hook, "source.hook") : optionalNullableString(source.hook, "source.hook");
  const outputs = optionalNullableRecord(source.outputs, "source.outputs");
  const graph = type === "graph" ? validateGraphSource(source.graph) : undefined;
  const http = validateHttpSource(source, type);
  const act = validateActDeclaration(source.act, "source.act");
  const sandbox = validateSandbox(source.sandbox ?? runx?.sandbox);

  if ((type === "agent-task" || type === "harness-hook") && (source.command !== undefined || source.args !== undefined)) {
    throw new SkillValidationError(`${type} sources must not declare source.command or source.args.`);
  }

  return {
    type,
    command: optionalNullableString(source.command, "source.command"),
    args,
    cwd,
    timeoutSeconds,
    inputMode,
    sandbox,
    server: mcpServer,
    catalogRef,
    tool: mcpTool,
    arguments: mcpArguments,
    agentCardUrl: a2aAgentCardUrl,
    agentIdentity: a2aAgentIdentity,
    agent,
    task,
    hook,
    outputs,
    graph,
    http,
    act,
    raw: source,
  };
}

function validateGraphSource(value: unknown): ExecutionGraph {
  const graph = requiredNullableRecord(value, "source.graph");
  return validateGraphDocument(graph);
}

function validateToolSource(source: SkillSource, field: string): SkillSource {
  if (!["cli-tool", "mcp", "a2a", "catalog", "http"].includes(source.type)) {
    throw new SkillValidationError(`${field} must be one of cli-tool, mcp, a2a, catalog, or http for tool manifests.`);
  }
  return source;
}

function validateSourceType(value: string, field: string): void {
  if ((sourceTypes as readonly string[]).includes(value)) {
    return;
  }
  throw new SkillValidationError(`${field} ${value} is not a supported source type.`);
}

function validateHttpSource(source: Record<string, unknown>, type: string): SkillHttpSource | undefined {
  if (type !== "http") {
    return undefined;
  }
  const http = optionalNullableRecord(source.http, "source.http") ?? source;
  return {
    url: requiredNullableString(http.url, "source.url"),
    method: validateHttpMethod(optionalNullableString(http.method, "source.method")),
    headers: validateHttpHeaders(http.headers),
    allowPrivateNetwork: optionalNullableBoolean(http.allow_private_network, "source.allow_private_network"),
  };
}

function validateHttpMethod(method: string | undefined): string | undefined {
  if (method === undefined) {
    return undefined;
  }
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
    return method;
  }
  throw new SkillValidationError(`source.method ${method} is not supported; use GET, POST, PUT, PATCH, or DELETE.`);
}

function validateHttpHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  const headers = optionalNullableRecord(value, "source.headers");
  if (!headers) {
    return undefined;
  }
  for (const [key, entry] of Object.entries(headers)) {
    if (typeof entry !== "string") {
      throw new SkillValidationError(`source.headers.${key} must be a string.`);
    }
  }
  return headers as Readonly<Record<string, string>>;
}

const actFields = [
  "form",
  "form_from",
  "purpose",
  "purpose_from",
  "legitimacy",
  "legitimacy_from",
  "reason_from",
  "target_from",
  "decision_from",
  "effect_from",
  "effect_field_from",
  "effect_from_input",
  "effect_type",
  "effect_prefix",
  "effect_prefix_from",
  "actor_from",
  "authority_from",
  "authority_term_from",
  "authority_parent_from",
  "authority_subset_proof_from",
  "requested_scope_from",
  "previous_from",
  "reason_step",
  "effect_step",
] as const;

const actObjectFields = ["mint_authority"] as const;
const actAllowedFields = [...actFields, ...actObjectFields] as const;

function validateActDeclaration(value: unknown, field: string): ActDeclaration | undefined {
  const record = optionalNullableRecord(value, field);
  if (!record) {
    return undefined;
  }
  rejectUnknownFields(record, field, actAllowedFields);
  const validated: Record<string, string | MintAuthorityDirective> = {};
  for (const key of actFields) {
    const entry = optionalNullableString(record[key], `${field}.${key}`);
    if (entry !== undefined) {
      validated[key] = entry;
    }
  }
  const mintAuthority = validateMintAuthorityDirective(record.mint_authority, `${field}.mint_authority`);
  if (mintAuthority !== undefined) {
    validated.mint_authority = mintAuthority;
  }
  return validated as ActDeclaration;
}

function validateMintAuthorityDirective(value: unknown, field: string): MintAuthorityDirective | undefined {
  const record = optionalNullableRecord(value, field);
  if (!record) {
    return undefined;
  }
  rejectUnknownFields(record, field, ["source"]);
  const source = requiredNullableString(record.source, `${field}.source`);
  if (source !== "static_scopes" && source !== "requested_scope") {
    throw new SkillValidationError(`${field}.source must be static_scopes or requested_scope.`);
  }
  return { source };
}

function validateSandbox(value: unknown): SkillSandbox | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requiredNullableRecord(value, "sandbox");
  const profile = requiredSandboxProfile(record.profile, "sandbox.profile");
  const requireEnforcement = optionalNullableBoolean(record.require_enforcement, "sandbox.require_enforcement");
  const declaration = normalizeSandboxDeclaration({
    profile,
    cwdPolicy: optionalCwdPolicy(record.cwd_policy),
    envAllowlist: optionalNullableStringArray(record.env_allowlist, "sandbox.env_allowlist"),
    network: optionalNullableBoolean(record.network, "sandbox.network"),
    writablePaths: optionalNullableStringArray(record.writable_paths, "sandbox.writable_paths"),
    requireEnforcement,
  });
  return {
    profile: declaration.profile,
    cwdPolicy: declaration.cwdPolicy,
    envAllowlist: declaration.envAllowlist,
    network: declaration.network,
    writablePaths: declaration.writablePaths,
    requireEnforcement,
    raw: record,
  };
}

function validateMcpServer(value: unknown): SkillSource["server"] {
  const server = requiredNullableRecord(value, "source.server");
  return {
    command: requiredNullableString(server.command, "source.server.command"),
    args: optionalNullableStringArray(server.args, "source.server.args") ?? [],
    cwd: optionalNullableString(server.cwd, "source.server.cwd"),
  };
}

function validateInputs(inputs: Record<string, unknown>): Readonly<Record<string, SkillInput>> {
  const validated: Record<string, SkillInput> = {};

  for (const [name, input] of Object.entries(inputs)) {
    if (!isRecord(input)) {
      throw new SkillValidationError(`inputs.${name} must be an object.`);
    }

    validated[name] = {
      type: optionalNullableString(input.type, `inputs.${name}.type`) ?? "string",
      required: optionalNullableBoolean(input.required, `inputs.${name}.required`) ?? false,
      description: optionalNullableString(input.description, `inputs.${name}.description`),
      default: input.default,
    };
  }

  return validated;
}

function validateExecutionSemantics(value: unknown, field: string): ExecutionSemantics | undefined {
  const record = optionalNullableRecord(value, field);
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
  const record = optionalNullableRecord(value, field);
  if (!record) {
    return undefined;
  }
  return {
    code: optionalNullableString(record.code, `${field}.code`),
    summary: optionalNullableString(record.summary, `${field}.summary`),
    observed_at: optionalNullableString(record.observed_at, `${field}.observed_at`),
    data: optionalNullableRecord(record.data, `${field}.data`),
  };
}

function validateInputContext(value: unknown, field: string): ExecutionSemantics["input_context"] {
  const record = optionalNullableRecord(value, field);
  if (!record) {
    return undefined;
  }
  const maxBytes = optionalNullableNumber(record.max_bytes, `${field}.max_bytes`);
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new SkillValidationError(`${field}.max_bytes must be a positive integer.`);
  }
  return {
    capture: optionalNullableBoolean(record.capture, `${field}.capture`),
    source: optionalNullableString(record.source, `${field}.source`),
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
    const record = requiredNullableRecord(entry, `${field}[${index}]`);
    return {
      type: requiredNullableString(record.type, `${field}[${index}].type`),
      uri: requiredNullableString(record.uri, `${field}[${index}].uri`),
      label: optionalNullableString(record.label, `${field}[${index}].label`),
    };
  });
}

function optionalDisposition(value: unknown, field: string): ExecutionSemantics["disposition"] {
  const disposition = optionalNullableString(value, field);
  if (disposition === undefined) {
    return undefined;
  }
  if (!GOVERNED_DISPOSITIONS.includes(disposition as (typeof GOVERNED_DISPOSITIONS)[number])) {
    throw new SkillValidationError(
      `${field} must be one of ${GOVERNED_DISPOSITIONS.join(", ")}.`,
    );
  }
  return disposition as ExecutionSemantics["disposition"];
}

function optionalOutcomeState(value: unknown, field: string): ExecutionSemantics["outcome_state"] {
  const outcomeState = optionalNullableString(value, field);
  if (outcomeState === undefined) {
    return undefined;
  }
  if (!["pending", "complete", "expired"].includes(outcomeState)) {
    throw new SkillValidationError(`${field} must be one of pending, complete, or expired.`);
  }
  return outcomeState as ExecutionSemantics["outcome_state"];
}

function validateSkillRetry(value: unknown, field: string): SkillRetryPolicy | undefined {
  const retry = optionalNullableRecord(value, field);
  if (!retry) {
    return undefined;
  }
  const maxAttempts = optionalNullableNumber(retry.max_attempts, `${field}.max_attempts`) ?? 1;
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
  const record = requiredNullableRecord(value, field);
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
  const record = optionalNullableRecord(value, field);
  if (!record) {
    return undefined;
  }
  const emitsValue = record.emits;
  const emits =
    typeof emitsValue === "string"
      ? [emitsValue]
      : optionalNullableStringArray(emitsValue, `${field}.emits`);
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
  const allowedTools = optionalNullableStringArray(value, field);
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
  const record = optionalNullableRecord(value, field);
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
      validateHarnessCase(requiredNullableRecord(entry, `${field}.cases[${index}]`), `${field}.cases[${index}]`),
    ),
  };
}

function validateHarnessCase(value: Record<string, unknown>, field: string): RunnerHarnessCase {
  return {
    name: requiredNullableString(value.name, `${field}.name`),
    runner: optionalNonEmptyString(value.runner, `${field}.runner`),
    inputs: optionalNullableRecord(value.inputs, `${field}.inputs`) ?? {},
    env: validateHarnessEnv(optionalNullableRecord(value.env, `${field}.env`) ?? {}, `${field}.env`),
    caller: validateHarnessCaller(optionalNullableRecord(value.caller, `${field}.caller`) ?? {}, `${field}.caller`),
    expect: validateHarnessExpectation(requiredNullableRecord(value.expect, `${field}.expect`), `${field}.expect`),
  };
}

function validateHarnessCaller(value: Record<string, unknown>, field: string): HarnessCallerFixture {
  return {
    answers: optionalNullableRecord(value.answers, `${field}.answers`),
    approvals: validateHarnessApprovals(optionalNullableRecord(value.approvals, `${field}.approvals`) ?? {}, `${field}.approvals`),
  };
}

function validateHarnessExpectation(value: Record<string, unknown>, field: string): HarnessExpectation {
  return {
    status: optionalHarnessStatus(value.status, `${field}.status`),
    receipt: validateReceiptExpectation(optionalNullableRecord(value.receipt, `${field}.receipt`), `${field}.receipt`),
    steps: optionalNullableStringArray(value.steps, `${field}.steps`),
  };
}

function validateReceiptExpectation(
  value: Record<string, unknown> | undefined,
  field: string,
): ReceiptExpectation | undefined {
  if (!value) {
    return undefined;
  }
  return {
    schema: optionalReceiptSchema(value.schema, `${field}.schema`),
    status: optionalReceiptStatus(value.status, `${field}.status`),
    source_type: optionalNullableString(value.source_type, `${field}.source_type`),
    body_digest: optionalNullableString(value.body_digest, `${field}.body_digest`),
    receipt_digest: optionalNullableString(value.receipt_digest, `${field}.receipt_digest`),
    harness_id: optionalNullableString(value.harness_id, `${field}.harness_id`),
    state: optionalNullableString(value.state, `${field}.state`),
    disposition: optionalNullableString(value.disposition, `${field}.disposition`),
    reason_code: optionalNullableString(value.reason_code, `${field}.reason_code`),
    child_receipt_refs: optionalNullableStringArray(value.child_receipt_refs, `${field}.child_receipt_refs`),
    act_ids: optionalNullableStringArray(value.act_ids, `${field}.act_ids`),
    owner: optionalNullableString(value.owner, `${field}.owner`),
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
    value === "sealed" ||
    value === "failure" ||
    value === "needs_agent" ||
    value === "policy_denied" ||
    value === "escalated"
  ) {
    return value;
  }
  throw new SkillValidationError(`${field} must be sealed, failure, needs_agent, policy_denied, or escalated.`);
}

function optionalReceiptStatus(value: unknown, field: string): ReceiptExpectation["status"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "sealed" || value === "failure") {
    return value;
  }
  throw new SkillValidationError(`${field} must be sealed or failure.`);
}

function optionalReceiptSchema(value: unknown, field: string): ReceiptExpectation["schema"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "runx.receipt.v1") {
    return value;
  }
  throw new SkillValidationError(`${field} must be runx.receipt.v1.`);
}

function requiredNullableString(value: unknown, field: string): string {
  const stringValue = optionalNullableString(value, field);
  if (!stringValue) {
    throw new SkillValidationError(`${field} is required.`);
  }
  return stringValue;
}

function optionalNullableString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SkillValidationError(`${field} must be a string.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  const stringValue = optionalNullableString(value, field);
  if (stringValue !== undefined && stringValue.trim() === "") {
    throw new SkillValidationError(`${field} must not be empty.`);
  }
  return stringValue;
}

function requiredNullableRecord(value: unknown, field: string): Record<string, unknown> {
  const record = optionalNullableRecord(value, field);
  if (!record) {
    throw new SkillValidationError(`${field} is required.`);
  }
  return record;
}

function optionalNullableRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new SkillValidationError(`${field} must be an object.`);
  }
  return value;
}

function optionalNullableStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SkillValidationError(`${field} must be an array of strings.`);
  }
  return value;
}

function optionalNullableNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SkillValidationError(`${field} must be a finite number.`);
  }
  return value;
}

function optionalNullableBoolean(value: unknown, field: string): boolean | undefined {
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
  const profile = requiredNullableString(value, field);
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

function rejectUnknownFields(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new SkillValidationError(`${field}.${key} is not supported; allowed fields: ${allowed.join(", ")}.`);
    }
  }
}

function assertYamlSubset(field: string, yaml: string, kind: "execution-profile" | "parity"): void {
  try {
    if (kind === "execution-profile") {
      assertExecutionProfileYamlSubset(field, yaml);
    } else {
      assertYamlParitySubset(field, yaml);
    }
  } catch (error) {
    if (error instanceof YamlSubsetError) {
      throw new SkillParseError(error.message, { cause: error });
    }
    throw error;
  }
}

const sourceTypes = [
  "cli-tool",
  "mcp",
  "catalog",
  "a2a",
  "agent",
  "agent-task",
  "harness-hook",
  "graph",
  "http",
  "external-adapter",
  "thread-outbox-provider",
] as const;

const sourceFields = [
  "act",
  "agent",
  "agent_card_url",
  "agent_identity",
  "allow_private_network",
  "args",
  "arguments",
  "catalog_ref",
  "command",
  "cwd",
  "external_adapter",
  "external_adapter_manifest",
  "external_adapter_manifest_path",
  "graph",
  "headers",
  "hook",
  "http",
  "input_mode",
  "invocation_id",
  "method",
  "outputs",
  "run_id",
  "sandbox",
  "server",
  "skill_ref",
  "task",
  "timeout_seconds",
  "tool",
  "type",
  "url",
] as const;

const runnerFields = [
  ...sourceFields,
  "allowed_tools",
  "artifacts",
  "auth",
  "context",
  "context_skills",
  "default",
  "execution",
  "idempotency",
  "inputs",
  "instructions",
  "mutating",
  "policy",
  "retry",
  "risk",
  "runx",
  "runtime",
  "scopes",
  "source",
] as const;


export * from "./graph.js";
