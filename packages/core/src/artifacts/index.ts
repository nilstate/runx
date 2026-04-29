export const artifactsPackage = "@runxhq/core/artifacts";

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  ledgerCanonicalization,
  ledgerChainSchemaVersion,
  ledgerHashAlgorithm,
  ledgerRecordSchemaVersion,
  validateArtifactEnvelopeContract,
  validateLedgerRecordContract,
} from "@runxhq/contracts";
import type { LedgerChainContract } from "@runxhq/contracts";

import { hashStable, hashString, stableStringify } from "../util/hash.js";
import { errorMessage, isNotFound } from "../util/types.js";

export { hashStable, hashString, stableStringify };

export interface ArtifactContract {
  readonly emits?: readonly string[];
  readonly namedEmits?: Readonly<Record<string, string>>;
  readonly wrapAs?: string;
}

export interface ArtifactEnvelope {
  readonly type: string | null;
  readonly version: "1";
  readonly data: Readonly<Record<string, unknown>>;
  readonly meta: ArtifactMeta;
}

export interface ArtifactMeta {
  readonly artifact_id: string;
  readonly run_id: string;
  readonly step_id: string | null;
  readonly producer: {
    readonly skill: string;
    readonly runner: string;
  };
  readonly created_at: string;
  readonly hash: string;
  readonly size_bytes: number;
  readonly parent_artifact_id: string | null;
  readonly receipt_id: string | null;
  readonly redacted: boolean;
}

export interface LedgerAppendOptions {
  readonly receiptDir: string;
  readonly runId: string;
  readonly entries: readonly ArtifactEnvelope[];
  readonly appendLock?: LedgerAppendLockOptions;
}

export interface LedgerAppendLockOptions {
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

export interface ResolvedLedgerAppendLockOptions {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export interface LedgerRecord {
  readonly schema_version: typeof ledgerRecordSchemaVersion;
  readonly chain: LedgerChainContract;
  readonly entry: ArtifactEnvelope;
}

export interface ParsedLedgerRecord {
  readonly line: number;
  readonly entry: ArtifactEnvelope;
  readonly chain: LedgerChainContract;
}

export const ledgerAnchorVersion = "runx.ledger.anchor.v1" as const;
const ledgerAnchorKeys = new Set(["version", "run_id", "entry_count", "head_hash", "algorithm", "canonicalization"]);
const ledgerAppendLockMarkerVersion = "runx.ledger.append-lock.v1";
const defaultLedgerAppendLockOptions: ResolvedLedgerAppendLockOptions = {
  maxAttempts: 200,
  retryDelayMs: 10,
};

export interface LedgerAnchor {
  readonly version: typeof ledgerAnchorVersion;
  readonly run_id: string;
  readonly entry_count: number;
  readonly head_hash: string | null;
  readonly algorithm: typeof ledgerHashAlgorithm;
  readonly canonicalization: typeof ledgerCanonicalization;
}

export type LedgerVerificationStatus = "missing" | "valid" | "invalid";

export interface LedgerVerification {
  readonly status: LedgerVerificationStatus;
  readonly reason?: string;
  readonly runId: string;
  readonly ledgerPath: string;
  readonly entryCount: number;
  readonly headHash: string | null;
}

export interface LedgerInspection {
  readonly records: readonly ParsedLedgerRecord[];
  readonly entries: readonly ArtifactEnvelope[];
  readonly verification: LedgerVerification;
}

export interface PreparedLedgerAppend {
  readonly receiptDir: string;
  readonly runId: string;
  readonly ledgerPath: string;
  readonly records: readonly LedgerRecord[];
  readonly anchor: LedgerAnchor;
  readonly expectedEntryCount: number;
  readonly expectedHeadHash: string | null;
  readonly appendLock: ResolvedLedgerAppendLockOptions;
}

export interface ArtifactProducer {
  readonly skill: string;
  readonly runner: string;
}

export interface ArtifactEnvelopeSeed {
  readonly type: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly stepId?: string;
  readonly producer: ArtifactProducer;
  readonly createdAt?: string;
  readonly parentArtifactId?: string;
  readonly receiptId?: string;
  readonly redacted?: boolean;
}

export interface MaterializedArtifacts {
  readonly envelopes: readonly ArtifactEnvelope[];
  readonly fields: Readonly<Record<string, unknown>>;
}

export const SYSTEM_ARTIFACT_TYPES = new Set(["run_event", "receipt_link"]);

export function createArtifactEnvelope(seed: ArtifactEnvelopeSeed): ArtifactEnvelope {
  const payload = {
    type: seed.type,
    version: "1" as const,
    data: seed.data,
  };
  const hash = hashStable(payload);
  return {
    ...payload,
    meta: {
      artifact_id: `ax_${hash.slice(0, 16)}`,
      run_id: seed.runId,
      step_id: seed.stepId ?? null,
      producer: seed.producer,
      created_at: seed.createdAt ?? new Date().toISOString(),
      hash,
      size_bytes: Buffer.byteLength(JSON.stringify(seed.data), "utf8"),
      parent_artifact_id: seed.parentArtifactId ?? null,
      receipt_id: seed.receiptId ?? null,
      redacted: seed.redacted ?? false,
    },
  };
}

export function materializeArtifacts(options: {
  readonly stdout: string;
  readonly contract?: ArtifactContract;
  readonly runId: string;
  readonly stepId?: string;
  readonly producer: ArtifactProducer;
  readonly createdAt?: string;
}): MaterializedArtifacts {
  const parsed = parseJsonRecord(options.stdout);
  const contract = options.contract;

  if (contract?.namedEmits) {
    return materializeNamedArtifacts({
      parsed,
      contract,
      runId: options.runId,
      stepId: options.stepId,
      producer: options.producer,
      createdAt: options.createdAt,
    });
  }

  if (contract?.wrapAs) {
    const data = parsed ?? { raw: options.stdout };
    const envelope = createArtifactEnvelope({
      type: contract.wrapAs,
      data,
      runId: options.runId,
      stepId: options.stepId,
      producer: options.producer,
      createdAt: options.createdAt,
    });
    return {
      envelopes: [envelope],
      fields: {
        [contract.wrapAs]: envelope,
        data: envelope.data,
        raw: options.stdout,
      },
    };
  }

  if (contract?.emits && contract.emits.length > 0) {
    const declared = contract.emits;
    const rawArtifacts = Array.isArray(parsed?.artifacts) ? parsed.artifacts : parsed ? [parsed] : [{ raw: options.stdout }];
    if (rawArtifacts.length !== declared.length) {
      throw new Error(`Expected ${declared.length} emitted artifact(s) but received ${rawArtifacts.length}.`);
    }
    const envelopes = declared.map((type, index) =>
      createArtifactEnvelope({
        type,
        data: ensureArtifactData(rawArtifacts[index], `artifacts.${index}`),
        runId: options.runId,
        stepId: options.stepId,
        producer: options.producer,
        createdAt: options.createdAt,
      }),
    );
    return {
      envelopes,
      fields: {
        artifacts: envelopes,
        raw: options.stdout,
      },
    };
  }

  if (parsed) {
    const envelope = createArtifactEnvelope({
      type: null,
      data: parsed,
      runId: options.runId,
      stepId: options.stepId,
      producer: options.producer,
      createdAt: options.createdAt,
    });
    return {
      envelopes: [envelope],
      fields: {
        ...parsed,
        raw: options.stdout,
      },
    };
  }

  const envelope = createArtifactEnvelope({
    type: null,
    data: { raw: options.stdout },
    runId: options.runId,
    stepId: options.stepId,
    producer: options.producer,
    createdAt: options.createdAt,
  });
  return {
    envelopes: [envelope],
    fields: {
      raw: options.stdout,
    },
  };
}

export function createRunEventEntry(options: {
  readonly runId: string;
  readonly stepId?: string;
  readonly producer: ArtifactProducer;
  readonly kind: string;
  readonly status: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}): ArtifactEnvelope {
  return createArtifactEnvelope({
    type: "run_event",
    data: {
      kind: options.kind,
      status: options.status,
      step_id: options.stepId ?? null,
      detail: options.detail ?? {},
    },
    runId: options.runId,
    stepId: options.stepId,
    producer: options.producer,
    createdAt: options.createdAt,
  });
}

export function createReceiptLinkEntry(options: {
  readonly runId: string;
  readonly producer: ArtifactProducer;
  readonly artifactId: string;
  readonly receiptId: string;
  readonly stepId?: string;
  readonly createdAt?: string;
}): ArtifactEnvelope {
  return createArtifactEnvelope({
    type: "receipt_link",
    data: {
      artifact_id: options.artifactId,
      receipt_id: options.receiptId,
    },
    runId: options.runId,
    stepId: options.stepId,
    producer: options.producer,
    createdAt: options.createdAt,
  });
}

export async function appendLedgerEntries(options: LedgerAppendOptions): Promise<string> {
  return await appendPreparedLedgerEntries(await prepareLedgerAppend(options));
}

export async function prepareLedgerAppend(options: LedgerAppendOptions): Promise<PreparedLedgerAppend> {
  const ledgerPath = resolveLedgerPath(options.receiptDir, options.runId);
  const appendLock = normalizeLedgerAppendLockOptions(options.appendLock);
  const inspection = await inspectLedger(options.receiptDir, options.runId);
  if (inspection.verification.status === "invalid") {
    throw new Error(`Cannot append to invalid ledger ${ledgerPath}: ${inspection.verification.reason ?? "invalid_chain"}`);
  }

  let previousHash = inspection.verification.headHash;
  let index = inspection.verification.entryCount;
  const records = options.entries.map((entry) => {
    const validated = validateArtifactEnvelopeContract(entry, `ledger append entry ${index}`) as ArtifactEnvelope;
    assertSystemLedgerEntryRunId(validated, options.runId, index);
    const chain = createLedgerChain(index, previousHash, validated);
    previousHash = chain.entry_hash;
    index += 1;
    return {
      schema_version: ledgerRecordSchemaVersion,
      chain,
      entry: validated,
    } satisfies LedgerRecord;
  });

  return {
    receiptDir: options.receiptDir,
    runId: options.runId,
    ledgerPath,
    records,
    anchor: {
      version: ledgerAnchorVersion,
      run_id: options.runId,
      entry_count: index,
      head_hash: previousHash,
      algorithm: ledgerHashAlgorithm,
      canonicalization: ledgerCanonicalization,
    },
    expectedEntryCount: inspection.verification.entryCount,
    expectedHeadHash: inspection.verification.headHash,
    appendLock,
  };
}

function assertSystemLedgerEntryRunId(entry: ArtifactEnvelope, runId: string, index: number): void {
  if (entry.type === null || !SYSTEM_ARTIFACT_TYPES.has(entry.type)) {
    return;
  }
  if (entry.meta.run_id !== runId) {
    throw new Error(
      `ledger append entry ${index} has run_id ${entry.meta.run_id}; expected ${runId} for ${entry.type} ledger event.`,
    );
  }
}

function normalizeLedgerAppendLockOptions(options: LedgerAppendLockOptions | undefined): ResolvedLedgerAppendLockOptions {
  return {
    maxAttempts: normalizePositiveInteger(
      options?.maxAttempts,
      "appendLock.maxAttempts",
      defaultLedgerAppendLockOptions.maxAttempts,
    ),
    retryDelayMs: normalizeNonNegativeNumber(
      options?.retryDelayMs,
      "appendLock.retryDelayMs",
      defaultLedgerAppendLockOptions.retryDelayMs,
    ),
  };
}

function normalizePositiveInteger(value: number | undefined, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeNonNegativeNumber(value: number | undefined, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return value;
}

async function withLedgerAppendLock<T>(
  ledgerPath: string,
  options: ResolvedLedgerAppendLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${ledgerPath}.lock`;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    let handle: FileHandle | undefined;
    let marker: string | undefined;
    let markerWritten = false;
    let operationError: unknown;
    try {
      marker = createLedgerAppendLockMarker();
      handle = await open(lockPath, "wx");
      await handle.writeFile(marker);
      markerWritten = true;
      return await fn();
    } catch (error) {
      operationError = error;
      if (handle) {
        throw error;
      }
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await removeStaleLedgerAppendLock(lockPath)) {
        continue;
      }
      await sleep(options.retryDelayMs);
    } finally {
      if (handle) {
        try {
          await releaseLedgerAppendLock(handle, lockPath, marker, markerWritten);
        } catch (error) {
          if (operationError === undefined) {
            throw error;
          }
        }
      }
    }
  }
  throw new Error(`Cannot append to ledger ${ledgerPath}: timed out waiting for append lock after ${options.maxAttempts} attempts.`);
}

function createLedgerAppendLockMarker(): string {
  return `${JSON.stringify({
    version: ledgerAppendLockMarkerVersion,
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
  })}\n`;
}

async function releaseLedgerAppendLock(
  handle: FileHandle,
  lockPath: string,
  marker: string | undefined,
  markerWritten: boolean,
): Promise<void> {
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (markerWritten && marker) {
    await removeLedgerAppendLockIfMarkerMatches(lockPath, marker);
  } else {
    await rm(lockPath, { force: true });
  }
  if (closeError !== undefined) {
    throw closeError;
  }
}

async function removeStaleLedgerAppendLock(lockPath: string): Promise<boolean> {
  return await withLedgerAppendLockRecovery(lockPath, async () => {
    const contents = await readLedgerAppendLockMarker(lockPath);
    if (contents === undefined) {
      return true;
    }
    const marker = parseLedgerAppendLockMarker(contents);
    if (!marker) {
      return await removeLedgerAppendLockIfMarkerMatches(lockPath, contents);
    }
    try {
      process.kill(marker.pid, 0);
      return false;
    } catch (error) {
      if (isNoSuchProcess(error)) {
        return await removeLedgerAppendLockIfMarkerMatches(lockPath, contents);
      }
      return false;
    }
  });
}

async function withLedgerAppendLockRecovery(lockPath: string, fn: () => Promise<boolean>): Promise<boolean> {
  const recoveryLockPath = `${lockPath}.recovery`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(recoveryLockPath, "wx");
    await handle.writeFile(createLedgerAppendLockMarker());
    return await fn();
  } catch (error) {
    if (!handle && isAlreadyExists(error)) {
      return false;
    }
    throw error;
  } finally {
    if (handle) {
      await releaseLedgerAppendRecoveryLock(handle, recoveryLockPath);
    }
  }
}

async function releaseLedgerAppendRecoveryLock(handle: FileHandle, recoveryLockPath: string): Promise<void> {
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  await rm(recoveryLockPath, { force: true });
  if (closeError !== undefined) {
    throw closeError;
  }
}

async function readLedgerAppendLockMarker(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function removeLedgerAppendLockIfMarkerMatches(lockPath: string, expectedMarker: string): Promise<boolean> {
  const current = await readLedgerAppendLockMarker(lockPath);
  if (current === undefined) {
    return true;
  }
  if (current !== expectedMarker) {
    return false;
  }
  await rm(lockPath, { force: true });
  return true;
}

function parseLedgerAppendLockMarker(contents: string): { readonly pid: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== ledgerAppendLockMarkerVersion
    || !Number.isInteger(record.pid)
    || typeof record.pid !== "number"
    || record.pid <= 0
    || typeof record.token !== "string"
    || record.token.length === 0
    || typeof record.created_at !== "string"
  ) {
    return undefined;
  }
  return {
    pid: record.pid,
  };
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { readonly code?: unknown }).code === "EEXIST",
  );
}

function isNoSuchProcess(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ESRCH",
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function appendPreparedLedgerEntries(plan: PreparedLedgerAppend): Promise<string> {
  await mkdir(path.dirname(plan.ledgerPath), { recursive: true });

  await withLedgerAppendLock(plan.ledgerPath, plan.appendLock, async () => {
    const current = await inspectLedger(plan.receiptDir, plan.runId);
    if (current.verification.status === "invalid") {
      throw new Error(`Cannot append to invalid ledger ${plan.ledgerPath}: ${current.verification.reason ?? "invalid_chain"}`);
    }
    if (
      current.verification.entryCount !== plan.expectedEntryCount
      || current.verification.headHash !== plan.expectedHeadHash
    ) {
      throw new Error(`Cannot append to ledger ${plan.ledgerPath}: ledger changed while append was being prepared.`);
    }

    if (plan.records.length > 0) {
      await appendLedgerRecords(plan.ledgerPath, plan.records);
    }
  });
  return plan.ledgerPath;
}

async function appendLedgerRecords(ledgerPath: string, records: readonly LedgerRecord[]): Promise<void> {
  const handle = await open(ledgerPath, "a");
  let operationError: unknown;
  try {
    for (const record of records) {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
    }
    await handle.sync();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (operationError === undefined) {
        throw error;
      }
    }
  }
}

export async function readLedgerEntries(receiptDir: string, runId: string): Promise<readonly ArtifactEnvelope[]> {
  const inspection = await inspectLedger(receiptDir, runId);
  if (inspection.verification.status === "invalid") {
    throw new Error(`Ledger ${inspection.verification.ledgerPath} failed verification: ${inspection.verification.reason ?? "invalid_chain"}`);
  }
  return inspection.entries;
}

export async function readLedgerRecords(receiptDir: string, runId: string): Promise<readonly ParsedLedgerRecord[]> {
  const ledgerPath = resolveLedgerPath(receiptDir, runId);
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const lines = contents.split(/\r?\n/);
  const records: ParsedLedgerRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${ledgerPath}:${index + 1} is not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    records.push(parseLedgerRecord(parsed, `${ledgerPath}:${index + 1}`, index + 1));
  }
  return records;
}

export async function inspectLedger(optionsReceiptDir: string, runId: string, expectedAnchor?: LedgerAnchor): Promise<LedgerInspection> {
  const ledgerPath = resolveLedgerPath(optionsReceiptDir, runId);
  let records: readonly ParsedLedgerRecord[];
  try {
    records = await readLedgerRecords(optionsReceiptDir, runId);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        records: [],
        entries: [],
        verification: applyExpectedLedgerAnchor({
          status: "missing",
          reason: undefined,
          runId,
          ledgerPath,
          entryCount: 0,
          headHash: null,
        }, expectedAnchor),
      };
    }
    return {
      records: [],
      entries: [],
      verification: {
        status: "invalid",
        reason: errorMessage(error),
        runId,
        ledgerPath,
        entryCount: 0,
        headHash: null,
      },
    };
  }

  const verification = applyExpectedLedgerAnchor(
    verifyParsedLedgerRecords(records, ledgerPath, runId),
    expectedAnchor,
    records,
  );
  return {
    records,
    entries: records.map((record) => record.entry),
    verification,
  };
}

export function resolveLedgerPath(receiptDir: string, runId: string): string {
  return path.join(receiptDir, "ledgers", `${runId}.jsonl`);
}

export function createLedgerAnchorMetadata(anchor: LedgerAnchor): Readonly<Record<string, unknown>> {
  return {
    runx: {
      ledger: anchor,
    },
  };
}

export function parseLedgerAnchorMetadata(metadata: unknown): LedgerAnchor | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const runx = (metadata as Record<string, unknown>).runx;
  if (!runx || typeof runx !== "object" || Array.isArray(runx)) {
    return undefined;
  }
  const ledger = (runx as Record<string, unknown>).ledger;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return undefined;
  }
  const candidate = ledger as Record<string, unknown>;
  if (
    candidate.version !== ledgerAnchorVersion
    || candidate.algorithm !== ledgerHashAlgorithm
    || candidate.canonicalization !== ledgerCanonicalization
    || typeof candidate.run_id !== "string"
    || !Number.isInteger(candidate.entry_count)
    || typeof candidate.entry_count !== "number"
    || candidate.entry_count < 0
    || Object.keys(candidate).some((key) => !ledgerAnchorKeys.has(key))
    || !(typeof candidate.head_hash === "string" || candidate.head_hash === null)
  ) {
    return undefined;
  }
  return {
    version: ledgerAnchorVersion,
    run_id: candidate.run_id,
    entry_count: candidate.entry_count,
    head_hash: candidate.head_hash,
    algorithm: ledgerHashAlgorithm,
    canonicalization: ledgerCanonicalization,
  };
}

function parseLedgerRecord(value: unknown, label: string, line: number): ParsedLedgerRecord {
  const record = validateLedgerRecordContract(value, label);
  return {
    line,
    chain: record.chain,
    entry: record.entry as ArtifactEnvelope,
  };
}

function verifyParsedLedgerRecords(
  records: readonly ParsedLedgerRecord[],
  ledgerPath: string,
  runId: string,
): LedgerVerification {
  let previousHash: string | null = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const expected = createLedgerChain(index, previousHash, record.entry);
    const reason = compareLedgerChain(record.chain, expected, record.line);
    if (reason) {
      return {
        status: "invalid",
        reason,
        runId,
        ledgerPath,
        entryCount: records.length,
        headHash: previousHash,
      };
    }
    previousHash = expected.entry_hash;
  }

  return {
    status: records.length === 0 ? "missing" : "valid",
    runId,
    ledgerPath,
    entryCount: records.length,
    headHash: previousHash,
  };
}

function compareLedgerChain(
  actual: LedgerChainContract,
  expected: LedgerChainContract,
  line: number,
): string | undefined {
  if (actual.version !== expected.version) {
    return `line ${line} chain version mismatch`;
  }
  if (actual.algorithm !== expected.algorithm) {
    return `line ${line} chain algorithm mismatch`;
  }
  if (actual.canonicalization !== expected.canonicalization) {
    return `line ${line} chain canonicalization mismatch`;
  }
  if (actual.index !== expected.index) {
    return `line ${line} chain index mismatch`;
  }
  if (actual.previous_hash !== expected.previous_hash) {
    return `line ${line} previous hash mismatch`;
  }
  if (actual.entry_hash !== expected.entry_hash) {
    return `line ${line} entry hash mismatch`;
  }
  return undefined;
}

function applyExpectedLedgerAnchor(
  verification: LedgerVerification,
  expectedAnchor: LedgerAnchor | undefined,
  records: readonly ParsedLedgerRecord[] = [],
): LedgerVerification {
  if (!expectedAnchor || verification.status === "invalid") {
    return verification;
  }
  if (expectedAnchor.version !== ledgerAnchorVersion) {
    return markLedgerInvalid(verification, "ledger anchor version mismatch");
  }
  if (expectedAnchor.algorithm !== ledgerHashAlgorithm || expectedAnchor.canonicalization !== ledgerCanonicalization) {
    return markLedgerInvalid(verification, "ledger anchor hash parameters mismatch");
  }
  if (expectedAnchor.run_id !== verification.runId) {
    return markLedgerInvalid(verification, "ledger anchor run id mismatch");
  }
  if (expectedAnchor.entry_count > verification.entryCount) {
    return markLedgerInvalid(verification, "ledger anchor entry count mismatch");
  }
  if (expectedAnchor.head_hash !== hashLedgerRecordPrefix(records, expectedAnchor.entry_count)) {
    return markLedgerInvalid(verification, "ledger anchor head hash mismatch");
  }
  return verification;
}

function markLedgerInvalid(verification: LedgerVerification, reason: string): LedgerVerification {
  return {
    ...verification,
    status: "invalid",
    reason,
  };
}

function createLedgerChain(
  index: number,
  previousHash: string | null,
  entry: ArtifactEnvelope,
): LedgerChainContract {
  return {
    version: ledgerChainSchemaVersion,
    algorithm: ledgerHashAlgorithm,
    canonicalization: ledgerCanonicalization,
    index,
    previous_hash: previousHash,
    entry_hash: hashLedgerChainEntry(index, previousHash, entry),
  };
}

function hashLedgerChainEntry(index: number, previousHash: string | null, entry: ArtifactEnvelope): string {
  return hashStable({
    version: "runx.ledger.chain-payload.v1",
    index,
    previous_hash: previousHash,
    entry,
  });
}

function hashLedgerRecordPrefix(records: readonly ParsedLedgerRecord[], entryCount: number): string | null {
  let previousHash: string | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const record = records[index];
    if (!record) {
      return null;
    }
    previousHash = hashLedgerChainEntry(index, previousHash, record.entry);
  }
  return previousHash;
}

function materializeNamedArtifacts(options: {
  readonly parsed: Readonly<Record<string, unknown>> | undefined;
  readonly contract: ArtifactContract;
  readonly runId: string;
  readonly stepId?: string;
  readonly producer: ArtifactProducer;
  readonly createdAt?: string;
}): MaterializedArtifacts {
  if (!options.parsed) {
    throw new Error("named_emits requires JSON object stdout.");
  }
  const namedEmits = options.contract.namedEmits ?? {};
  const envelopes: ArtifactEnvelope[] = [];
  const fields: Record<string, unknown> = {};
  for (const [fieldName, artifactType] of Object.entries(namedEmits)) {
    if (!(fieldName in options.parsed)) {
      throw new Error(`Missing declared artifact field '${fieldName}'.`);
    }
    const envelope = createArtifactEnvelope({
      type: artifactType,
      data: ensureArtifactData(options.parsed[fieldName], fieldName),
      runId: options.runId,
      stepId: options.stepId,
      producer: options.producer,
      createdAt: options.createdAt,
    });
    envelopes.push(envelope);
    fields[fieldName] = envelope;
  }
  for (const key of Object.keys(options.parsed)) {
    if (!(key in namedEmits)) {
      fields[key] = options.parsed[key];
    }
  }
  return {
    envelopes,
    fields,
  };
}

function ensureArtifactData(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Artifact payload '${field}' must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseJsonRecord(stdout: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}
