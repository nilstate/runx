export const receiptsPackage = "@runx/receipts";
export * from "./local-signing.js";
export * from "./outcome-resolution.js";

export const CONTROL_SCHEMA_REFS = {
  scope_admission: "https://runx.ai/spec/scope-admission.schema.json",
} as const;

import crypto, { createHash, type KeyObject } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultRunxHome,
  loadLocalPublicKey,
  loadOrCreateLocalKey,
  localIssuer,
  signPayloadString,
  stableStringify,
  verifyPayloadString,
  type LocalKeyPair,
} from "./local-signing.js";
import type { OutcomeState, ReceiptOutcome } from "./outcome-resolution.js";

export interface ReceiptExecution {
  readonly status: "success" | "failure";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuthReceiptMetadata {
  readonly auth: {
    readonly grant_id: string;
    readonly provider: string;
    readonly connection_id: string;
    readonly scopes: readonly string[];
    readonly grant_reference?: {
      readonly grant_id: string;
      readonly scope_family: string;
      readonly authority_kind: "read_only" | "constructive" | "destructive";
      readonly target_repo?: string;
      readonly target_locator?: string;
    };
  };
}

export interface AgentHookReceiptMetadata {
  readonly agent_hook: {
    readonly source_type: "agent-step" | "harness-hook";
    readonly agent?: string;
    readonly hook?: string;
    readonly task?: string;
    readonly route?: string;
    readonly status: "success" | "failure";
  };
}

export interface ApprovalReceiptMetadata {
  readonly approval: {
    readonly gate_id: string;
    readonly gate_type: string;
    readonly decision: "approved" | "denied";
    readonly reason: string;
    readonly summary?: Readonly<Record<string, unknown>>;
  };
}

export interface RunnerReceiptMetadata {
  readonly runner: {
    readonly type?: string;
    readonly enforcement?: string;
    readonly attestation?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly prompt_version?: string;
    readonly base_url?: string;
  };
}

export type GovernedDisposition = "completed" | "needs_resolution" | "policy_denied" | "approval_required" | "observing";

export interface ReceiptSurfaceRef {
  readonly type: string;
  readonly uri: string;
  readonly label?: string;
}

export interface ReceiptInputContext {
  readonly source?: string;
  readonly snapshot?: unknown;
  readonly preview?: string;
  readonly bytes: number;
  readonly max_bytes: number;
  readonly truncated: boolean;
  readonly value_hash: string;
}

export interface InputContextCapture {
  readonly capture?: boolean;
  readonly source?: string;
  readonly max_bytes?: number;
  readonly snapshot?: unknown;
}

export interface ExecutionSemantics {
  readonly disposition?: GovernedDisposition;
  readonly outcome_state?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly input_context?: InputContextCapture;
  readonly surface_refs?: readonly ReceiptSurfaceRef[];
  readonly evidence_refs?: readonly ReceiptSurfaceRef[];
}

export interface BuildLocalReceiptOptions {
  readonly receiptId?: string;
  readonly skillName: string;
  readonly sourceType: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly stdout: string;
  readonly stderr: string;
  readonly execution: ReceiptExecution;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly parentReceipt?: string;
  readonly contextFrom?: readonly string[];
  readonly artifactIds?: readonly string[];
  readonly disposition?: GovernedDisposition;
  readonly inputContext?: ReceiptInputContext;
  readonly outcomeState?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surfaceRefs?: readonly ReceiptSurfaceRef[];
  readonly evidenceRefs?: readonly ReceiptSurfaceRef[];
}

export interface WriteLocalReceiptOptions extends BuildLocalReceiptOptions {
  readonly receiptDir: string;
  readonly runxHome?: string;
}

export interface ChainReceiptStep {
  readonly step_id: string;
  readonly attempt: number;
  readonly skill: string;
  readonly runner?: string;
  readonly status: "success" | "failure";
  readonly receipt_id?: string;
  readonly parent_receipt?: string;
  readonly fanout_group?: string;
  readonly retry?: {
    readonly attempt: number;
    readonly max_attempts: number;
    readonly rule_fired: string;
    readonly idempotency_key_hash?: string;
  };
  readonly context_from: readonly {
    readonly input: string;
    readonly from_step: string;
    readonly output: string;
    readonly receipt_id?: string;
  }[];
  readonly governance?: ChainReceiptGovernance;
  readonly artifact_ids?: readonly string[];
  readonly disposition?: GovernedDisposition;
  readonly input_context?: ReceiptInputContext;
  readonly outcome_state?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surface_refs?: readonly ReceiptSurfaceRef[];
  readonly evidence_refs?: readonly ReceiptSurfaceRef[];
}

export interface ChainReceiptGovernance {
  readonly scope_admission?: {
    readonly status: "allow" | "deny";
    readonly requested_scopes: readonly string[];
    readonly granted_scopes: readonly string[];
    readonly grant_id?: string;
    readonly reasons?: readonly string[];
    readonly decision_summary?: string;
  };
}

export interface ChainReceiptSyncPoint {
  readonly group_id: string;
  readonly strategy: "all" | "any" | "quorum";
  readonly decision: "proceed" | "halt" | "pause" | "escalate";
  readonly rule_fired: string;
  readonly reason: string;
  readonly branch_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly required_successes: number;
  readonly branch_receipts: readonly string[];
  readonly gate?: Readonly<Record<string, unknown>>;
}

export interface BuildLocalChainReceiptOptions {
  readonly chainId: string;
  readonly chainName: string;
  readonly owner?: string;
  readonly status: "success" | "failure";
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly output: string;
  readonly steps: readonly ChainReceiptStep[];
  readonly syncPoints?: readonly ChainReceiptSyncPoint[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly disposition?: GovernedDisposition;
  readonly inputContext?: ReceiptInputContext;
  readonly outcomeState?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surfaceRefs?: readonly ReceiptSurfaceRef[];
  readonly evidenceRefs?: readonly ReceiptSurfaceRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WriteLocalChainReceiptOptions extends BuildLocalChainReceiptOptions {
  readonly receiptDir: string;
  readonly runxHome?: string;
}

export type LocalReceipt = LocalSkillReceipt | LocalChainReceipt;

export type ReceiptVerificationStatus = "verified" | "unverified" | "invalid";

export interface ReceiptVerification {
  readonly status: ReceiptVerificationStatus;
  readonly reason?: string;
}

export interface VerifiedLocalReceipt {
  readonly receipt: LocalReceipt;
  readonly verification: ReceiptVerification;
}

export interface LocalSkillReceipt {
  readonly schema_version: "runx.receipt.v1";
  readonly id: string;
  readonly kind: "skill_execution";
  readonly issuer: {
    readonly type: "local";
    readonly kid: string;
    readonly public_key_sha256: string;
  };
  readonly subject: {
    readonly skill_name: string;
    readonly source_type: string;
  };
  readonly status: "success" | "failure";
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly duration_ms: number;
  readonly input_hash: string;
  readonly output_hash: string;
  readonly stderr_hash?: string;
  readonly context_from: readonly string[];
  readonly parent_receipt?: string;
  readonly artifact_ids?: readonly string[];
  readonly disposition?: GovernedDisposition;
  readonly input_context?: ReceiptInputContext;
  readonly outcome_state?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surface_refs?: readonly ReceiptSurfaceRef[];
  readonly evidence_refs?: readonly ReceiptSurfaceRef[];
  readonly execution: {
    readonly exit_code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error_hash?: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signature: {
    readonly alg: "Ed25519";
    readonly value: string;
  };
}

export interface LocalChainReceipt {
  readonly schema_version: "runx.receipt.v1";
  readonly id: string;
  readonly kind: "chain_execution";
  readonly issuer: {
    readonly type: "local";
    readonly kid: string;
    readonly public_key_sha256: string;
  };
  readonly subject: {
    readonly chain_name: string;
    readonly owner?: string;
  };
  readonly status: "success" | "failure";
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly duration_ms: number;
  readonly input_hash: string;
  readonly output_hash: string;
  readonly error_hash?: string;
  readonly disposition?: GovernedDisposition;
  readonly input_context?: ReceiptInputContext;
  readonly outcome_state?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surface_refs?: readonly ReceiptSurfaceRef[];
  readonly evidence_refs?: readonly ReceiptSurfaceRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly steps: readonly ChainReceiptStep[];
  readonly sync_points?: readonly ChainReceiptSyncPoint[];
  readonly signature: {
    readonly alg: "Ed25519";
    readonly value: string;
  };
}

export async function writeLocalReceipt(options: WriteLocalReceiptOptions): Promise<LocalSkillReceipt> {
  const keyPair = await loadOrCreateLocalKey(options.runxHome);
  const receipt = buildLocalReceipt(options, keyPair);
  await mkdir(options.receiptDir, { recursive: true });
  await writeFile(path.join(options.receiptDir, `${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

export async function writeLocalChainReceipt(options: WriteLocalChainReceiptOptions): Promise<LocalChainReceipt> {
  const keyPair = await loadOrCreateLocalKey(options.runxHome);
  const receipt = buildLocalChainReceipt(options, keyPair);
  await mkdir(options.receiptDir, { recursive: true });
  await writeFile(path.join(options.receiptDir, `${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

export async function readLocalReceipt(receiptDir: string, id: string): Promise<LocalReceipt> {
  assertLocalReceiptId(id);
  const contents = await readFile(path.join(receiptDir, `${id}.json`), "utf8");
  return JSON.parse(contents) as LocalReceipt;
}

export async function readVerifiedLocalReceipt(
  receiptDir: string,
  id: string,
  runxHome = defaultRunxHome(),
): Promise<VerifiedLocalReceipt> {
  const receipt = await readLocalReceipt(receiptDir, id);
  return {
    receipt,
    verification: await verifyLocalReceiptFromLocalKey(receipt, runxHome),
  };
}

export async function listLocalReceipts(receiptDir: string): Promise<readonly LocalReceipt[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(receiptDir);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const receipts = await Promise.all(
    entries
      .filter((entry) => /^(rx|cx)_[A-Za-z0-9_-]+\.json$/.test(entry))
      .map(async (entry) => JSON.parse(await readFile(path.join(receiptDir, entry), "utf8")) as LocalReceipt),
  );
  return receipts.sort((left, right) => receiptTimestamp(right).localeCompare(receiptTimestamp(left)));
}

export async function listVerifiedLocalReceipts(
  receiptDir: string,
  runxHome = defaultRunxHome(),
): Promise<readonly VerifiedLocalReceipt[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(receiptDir);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const receipts = await Promise.all(
    entries
      .filter((entry) => /^(rx|cx)_[A-Za-z0-9_-]+\.json$/.test(entry))
      .map(async (entry) => readVerifiedLocalReceipt(receiptDir, entry.slice(0, -".json".length), runxHome)),
  );
  return receipts.sort((left, right) => receiptTimestamp(right.receipt).localeCompare(receiptTimestamp(left.receipt)));
}

export function buildLocalReceipt(options: BuildLocalReceiptOptions, keyPair: LocalKeyPair): LocalSkillReceipt {
  const unsignedBase = {
    schema_version: "runx.receipt.v1" as const,
    kind: "skill_execution" as const,
    issuer: localIssuer(keyPair),
    subject: {
      skill_name: options.skillName,
      source_type: options.sourceType,
    },
    status: options.execution.status,
    started_at: options.startedAt,
    completed_at: options.completedAt,
    duration_ms: options.execution.durationMs,
    input_hash: hashStable(options.inputs),
    output_hash: hashString(options.stdout),
    stderr_hash: options.stderr ? hashString(options.stderr) : undefined,
    context_from: options.contextFrom ?? [],
    parent_receipt: options.parentReceipt,
    artifact_ids: options.artifactIds && options.artifactIds.length > 0 ? options.artifactIds : undefined,
    disposition: options.disposition ?? "completed",
    input_context: options.inputContext,
    outcome_state: options.outcomeState ?? "complete",
    outcome: options.outcome,
    surface_refs: options.surfaceRefs && options.surfaceRefs.length > 0 ? options.surfaceRefs : undefined,
    evidence_refs: options.evidenceRefs && options.evidenceRefs.length > 0 ? options.evidenceRefs : undefined,
    execution: {
      exit_code: options.execution.exitCode,
      signal: options.execution.signal,
      error_hash: options.execution.errorMessage ? hashString(options.execution.errorMessage) : undefined,
    },
    metadata: options.execution.metadata ? redactReceiptMetadata(options.execution.metadata) : undefined,
  };
  const id = options.receiptId ?? uniqueReceiptId("rx");
  const signedPayload = {
    ...unsignedBase,
    id,
  };
  const signature = signPayloadString(stableStringify(signedPayload), keyPair.privateKey);

  return {
    ...signedPayload,
    signature,
  };
}

export function buildLocalChainReceipt(
  options: BuildLocalChainReceiptOptions,
  keyPair: LocalKeyPair,
): LocalChainReceipt {
  const normalizedSteps = options.steps.map((step, index) => ({
    ...step,
    governance: validateChainReceiptGovernance(step.governance, `steps[${index}].governance`),
  }));
  const signedPayload = {
    schema_version: "runx.receipt.v1" as const,
    id: options.chainId,
    kind: "chain_execution" as const,
    issuer: localIssuer(keyPair),
    subject: {
      chain_name: options.chainName,
      owner: options.owner,
    },
    status: options.status,
    started_at: options.startedAt,
    completed_at: options.completedAt,
    duration_ms: options.durationMs,
    input_hash: hashStable(options.inputs),
    output_hash: hashString(options.output),
    error_hash: options.errorMessage ? hashString(options.errorMessage) : undefined,
    disposition: options.disposition ?? "completed",
    input_context: options.inputContext,
    outcome_state: options.outcomeState ?? "complete",
    outcome: options.outcome,
    surface_refs: options.surfaceRefs && options.surfaceRefs.length > 0 ? options.surfaceRefs : undefined,
    evidence_refs: options.evidenceRefs && options.evidenceRefs.length > 0 ? options.evidenceRefs : undefined,
    metadata: options.metadata ? redactReceiptMetadata(options.metadata) : undefined,
    steps: normalizedSteps,
    sync_points: options.syncPoints && options.syncPoints.length > 0 ? options.syncPoints : undefined,
  };
  const signature = signPayloadString(stableStringify(signedPayload), keyPair.privateKey);

  return {
    ...signedPayload,
    signature,
  };
}

export function verifyLocalReceipt(receipt: LocalReceipt, publicKey: KeyObject): boolean {
  const { signature, ...signedPayload } = receipt;
  return verifyPayloadString(stableStringify(signedPayload), signature, publicKey);
}

async function verifyLocalReceiptFromLocalKey(receipt: LocalReceipt, runxHome: string): Promise<ReceiptVerification> {
  if (receipt.schema_version !== "runx.receipt.v1" || receipt.signature?.alg !== "Ed25519") {
    return {
      status: "unverified",
      reason: "unsupported_receipt_version_or_signature_algorithm",
    };
  }

  const publicKey = await loadLocalPublicKey(runxHome);
  if (!publicKey) {
    return {
      status: "unverified",
      reason: "local_public_key_missing",
    };
  }

  if (receipt.issuer.public_key_sha256 !== publicKey.publicKeySha256) {
    return {
      status: "unverified",
      reason: "local_public_key_mismatch",
    };
  }

  try {
    return verifyLocalReceipt(receipt, publicKey.publicKey)
      ? { status: "verified" }
      : { status: "invalid", reason: "signature_mismatch" };
  } catch {
    return { status: "invalid", reason: "signature_mismatch" };
  }
}

export function hashStable(value: unknown): string {
  return hashString(stableStringify(value));
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function uniqueReceiptId(prefix: "rx" | "cx"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function redactReceiptMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactValue(value) as Readonly<Record<string, unknown>>;
}

export function redactReceiptValue<T>(value: T): T {
  return redactValue(value) as T;
}

export function validateChainReceiptGovernance(
  value: ChainReceiptGovernance | undefined,
  label = "governance",
): ChainReceiptGovernance | undefined {
  if (value === undefined) {
    return undefined;
  }

  return {
    scope_admission: validateScopeAdmission(value.scope_admission, `${label}.scope_admission`),
  };
}

export function validateScopeAdmission(
  value: ChainReceiptGovernance["scope_admission"] | undefined,
  label = "scope_admission",
): ChainReceiptGovernance["scope_admission"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must match ${CONTROL_SCHEMA_REFS.scope_admission}.`);
  }

  const status = requireEnum(value.status, `${label}.status`, ["allow", "deny"]);
  const requestedScopes = requireStringArray(value.requested_scopes, `${label}.requested_scopes`);
  const grantedScopes = requireStringArray(value.granted_scopes, `${label}.granted_scopes`);
  const grantId = optionalString(value.grant_id, `${label}.grant_id`);
  const reasons = value.reasons === undefined ? undefined : requireStringArray(value.reasons, `${label}.reasons`);
  const decisionSummary = optionalString(value.decision_summary, `${label}.decision_summary`, { allowEmpty: true });

  return {
    status,
    requested_scopes: requestedScopes,
    granted_scopes: grantedScopes,
    grant_id: grantId,
    reasons,
    decision_summary: decisionSummary,
  };
}

function assertLocalReceiptId(id: string): void {
  if (!/^(rx|cx)_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid receipt id '${id}'.`);
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      isSecretKey(key) ? "[redacted]" : redactValue(entryValue),
    ]),
  );
}

function isSecretKey(key: string): boolean {
  return /(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|raw[_-]?secret|raw[_-]?token)/i.test(key);
}

function receiptTimestamp(receipt: LocalReceipt): string {
  return receipt.completed_at ?? receipt.started_at ?? "";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requireEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const normalized = optionalString(value, label);
  if (!normalized || !allowed.includes(normalized as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")} (${CONTROL_SCHEMA_REFS.scope_admission}).`);
  }
  return normalized as T;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array (${CONTROL_SCHEMA_REFS.scope_admission}).`);
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string (${CONTROL_SCHEMA_REFS.scope_admission}).`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string (${CONTROL_SCHEMA_REFS.scope_admission}).`);
  }
  const normalized = options.allowEmpty ? value : value.trim();
  if (normalized.length === 0 && !options.allowEmpty) {
    throw new Error(`${label} must be a non-empty string (${CONTROL_SCHEMA_REFS.scope_admission}).`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
