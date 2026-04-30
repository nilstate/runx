export const receiptsPackage = "@runxhq/core/receipts";
export * from "./local-signing.js";
export * from "./outcome-resolution.js";

import {
  RUNX_CONTROL_SCHEMA_REFS,
  validateLocalReceiptContract,
  validateScopeAdmissionContract,
  type ScopeAdmissionContract,
} from "@runxhq/contracts";
import crypto, { type KeyObject } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage, isNotFound } from "../util/types.js";
import { hashStable, hashString, stableStringify } from "../util/hash.js";

export { hashStable, hashString, stableStringify };

export const CONTROL_SCHEMA_REFS = {
  scope_admission: RUNX_CONTROL_SCHEMA_REFS.scope_admission,
} as const;

import {
  defaultRunxHome,
  loadLocalPublicKey,
  loadOrCreateLocalKey,
  localIssuer,
  signPayloadString,
  verifyPayloadString,
  type LocalKeyPair,
} from "./local-signing.js";
import { assertReceiptLikeId } from "./outcome-resolution.js";
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

export const GOVERNED_DISPOSITIONS = [
  "completed",
  "needs_resolution",
  "policy_denied",
  "approval_required",
  "observing",
  "escalated",
] as const;

export type GovernedDisposition = (typeof GOVERNED_DISPOSITIONS)[number];

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

export interface GraphReceiptStep {
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
  readonly governance?: GraphReceiptGovernance;
  readonly artifact_ids?: readonly string[];
  readonly disposition?: GovernedDisposition;
  readonly input_context?: ReceiptInputContext;
  readonly outcome_state?: OutcomeState;
  readonly outcome?: ReceiptOutcome;
  readonly surface_refs?: readonly ReceiptSurfaceRef[];
  readonly evidence_refs?: readonly ReceiptSurfaceRef[];
}

export interface GraphReceiptGovernance {
  readonly scope_admission?: ScopeAdmissionContract;
}

export interface GraphReceiptSyncPoint {
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

export interface BuildLocalGraphReceiptOptions {
  readonly graphId: string;
  readonly graphName: string;
  readonly owner?: string;
  readonly status: "success" | "failure";
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly output: string;
  readonly steps: readonly GraphReceiptStep[];
  readonly syncPoints?: readonly GraphReceiptSyncPoint[];
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

export interface WriteLocalGraphReceiptOptions extends BuildLocalGraphReceiptOptions {
  readonly receiptDir: string;
  readonly runxHome?: string;
}

export type LocalReceipt = LocalSkillReceipt | LocalGraphReceipt;

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
  readonly skill_name: string;
  readonly source_type: string;
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

export interface LocalGraphReceipt {
  readonly schema_version: "runx.receipt.v1";
  readonly id: string;
  readonly kind: "graph_execution";
  readonly issuer: {
    readonly type: "local";
    readonly kid: string;
    readonly public_key_sha256: string;
  };
  readonly graph_name: string;
  readonly owner?: string;
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
  readonly steps: readonly GraphReceiptStep[];
  readonly sync_points?: readonly GraphReceiptSyncPoint[];
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

export async function writeLocalGraphReceipt(options: WriteLocalGraphReceiptOptions): Promise<LocalGraphReceipt> {
  const keyPair = await loadOrCreateLocalKey(options.runxHome);
  const receipt = buildLocalGraphReceipt(options, keyPair);
  await mkdir(options.receiptDir, { recursive: true });
  await writeFile(path.join(options.receiptDir, `${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

/**
 * Bypass: returns the parsed receipt without checking its signature. Prefer
 * `readVerifiedLocalReceipt` everywhere except inside test fixtures or the
 * verified-read wrapper itself.
 */
export async function readLocalReceipt(receiptDir: string, id: string): Promise<LocalReceipt> {
  assertReceiptLikeId(id);
  const receiptPath = path.join(receiptDir, `${id}.json`);
  const contents = await readFile(receiptPath, "utf8");
  return parseLocalReceiptContents(contents, receiptPath);
}

export async function removeLocalReceipt(receiptDir: string, id: string): Promise<void> {
  assertReceiptLikeId(id);
  await rm(path.join(receiptDir, `${id}.json`), { force: true });
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

/**
 * Bypass: returns parsed receipts without checking signatures. Prefer
 * `listVerifiedLocalReceipts` for any read path that fans into runtime
 * decisions (context derivation, governance, etc.).
 */
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

  const settled = await Promise.all(
    entries
      .filter((entry) => /^(rx|gx)_[A-Za-z0-9_-]+\.json$/.test(entry))
      .map(async (entry) => {
        const receiptPath = path.join(receiptDir, entry);
        try {
          return parseLocalReceiptContents(await readFile(receiptPath, "utf8"), receiptPath);
        } catch (error) {
          process.stderr.write(
            `warning: skipping receipt at ${receiptPath}: ${errorMessage(error)}\n`,
          );
          return undefined;
        }
      }),
  );
  const receipts = settled.filter((entry): entry is LocalReceipt => entry !== undefined);
  return receipts.sort((left, right) => receiptTimestamp(right).localeCompare(receiptTimestamp(left)));
}

function parseLocalReceiptContents(contents: string, receiptPath: string): LocalReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${receiptPath} is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return validateLocalReceiptContract(parsed, receiptPath) as LocalReceipt;
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

  // Listings are tolerant: a single corrupt or invalid-shape receipt must not
  // poison the whole list. Single-receipt reads (`readVerifiedLocalReceipt`)
  // remain strict; callers asking for a specific id still get a clear error.
  const settled = await Promise.all(
    entries
      .filter((entry) => /^(rx|gx)_[A-Za-z0-9_-]+\.json$/.test(entry))
      .map(async (entry) => {
        try {
          return await readVerifiedLocalReceipt(receiptDir, entry.slice(0, -".json".length), runxHome);
        } catch (error) {
          process.stderr.write(
            `warning: skipping receipt at ${path.join(receiptDir, entry)}: ${errorMessage(error)}\n`,
          );
          return undefined;
        }
      }),
  );
  const receipts = settled.filter((entry): entry is VerifiedLocalReceipt => entry !== undefined);
  return receipts.sort((left, right) => receiptTimestamp(right.receipt).localeCompare(receiptTimestamp(left.receipt)));
}

export function buildLocalReceipt(options: BuildLocalReceiptOptions, keyPair: LocalKeyPair): LocalSkillReceipt {
  assertNonEmptyReceiptIdentity(options.skillName, "skillName", options.sourceType);
  assertNonEmptyReceiptIdentity(options.sourceType, "sourceType", options.skillName);
  const unsignedBase = {
    schema_version: "runx.receipt.v1" as const,
    kind: "skill_execution" as const,
    issuer: localIssuer(keyPair),
    skill_name: options.skillName,
    source_type: options.sourceType,
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

export function buildLocalGraphReceipt(
  options: BuildLocalGraphReceiptOptions,
  keyPair: LocalKeyPair,
): LocalGraphReceipt {
  assertNonEmptyReceiptIdentity(options.graphName, "graphName", options.graphId);
  const normalizedSteps = options.steps.map((step, index) => ({
    ...step,
    governance: validateGraphReceiptGovernance(step.governance, `steps[${index}].governance`),
  }));
  const signedPayload = {
    schema_version: "runx.receipt.v1" as const,
    id: options.graphId,
    kind: "graph_execution" as const,
    issuer: localIssuer(keyPair),
    graph_name: options.graphName,
    owner: options.owner,
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

export function uniqueReceiptId(prefix: "rx" | "gx"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function redactReceiptMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactValue(value) as Readonly<Record<string, unknown>>;
}

export function redactReceiptValue<T>(value: T): T {
  return redactValue(value) as T;
}

export function validateGraphReceiptGovernance(
  value: GraphReceiptGovernance | undefined,
  label = "governance",
): GraphReceiptGovernance | undefined {
  if (value === undefined) {
    return undefined;
  }

  return {
    scope_admission: validateScopeAdmission(value.scope_admission, `${label}.scope_admission`),
  };
}

export function validateScopeAdmission(
  value: GraphReceiptGovernance["scope_admission"] | undefined,
  label = "scope_admission",
): GraphReceiptGovernance["scope_admission"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const admission = validateScopeAdmissionContract(value, label);
  return {
    status: admission.status,
    requested_scopes: admission.requested_scopes,
    granted_scopes: admission.granted_scopes,
    grant_id: admission.grant_id,
    reasons: admission.reasons,
    decision_summary: admission.decision_summary,
  };
}


function assertNonEmptyReceiptIdentity(
  value: string | null | undefined,
  fieldName: string,
  context: string | null | undefined,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    const ctx = typeof context === "string" && context.trim().length > 0 ? ` (context: ${context})` : "";
    throw new Error(`Receipt ${fieldName} must be a non-empty string${ctx}.`);
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
