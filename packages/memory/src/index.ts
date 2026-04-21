export const memoryPackage = "@runx/memory";

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type { LocalReceipt } from "../../receipts/src/index.js";

export const MEMORY_SCHEMA_REFS = {
  subject_memory: "https://runx.ai/spec/subject-memory.schema.json",
  publication_target: "https://runx.ai/spec/publication-target.schema.json",
  decision: "https://runx.ai/spec/subject-memory-decision.schema.json",
} as const;

export type SubjectMemoryEntryKind = "message" | "decision" | "status" | "artifact_ref" | "note";
export type SubjectMemoryDecisionValue = "allow" | "deny";
export type PublicationTargetKind = "pull_request" | "draft_change" | "patch_bundle" | "message" | "artifact";
export type PublicationTargetStatus = "proposed" | "draft" | "published" | "superseded" | "closed";

export interface MemoryEvidenceRef {
  readonly type: string;
  readonly uri: string;
  readonly label?: string;
  readonly recorded_at?: string;
}

export interface MemoryActor {
  readonly actor_id?: string;
  readonly display_name?: string;
  readonly role?: string;
  readonly provider_identity?: string;
}

export interface SubjectDescriptor {
  readonly subject_kind: string;
  readonly subject_locator: string;
  readonly title?: string;
  readonly canonical_uri?: string;
  readonly aliases?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SubjectMemoryEntry {
  readonly entry_id: string;
  readonly entry_kind: SubjectMemoryEntryKind;
  readonly recorded_at: string;
  readonly actor?: MemoryActor;
  readonly body?: string;
  readonly structured_data?: Readonly<Record<string, unknown>>;
  readonly source_ref?: MemoryEvidenceRef;
  readonly labels?: readonly string[];
  readonly supersedes?: readonly string[];
}

export interface SubjectMemoryDecision {
  readonly decision_id: string;
  readonly gate_id: string;
  readonly decision: SubjectMemoryDecisionValue;
  readonly recorded_at: string;
  readonly reason?: string;
  readonly author?: MemoryActor;
  readonly source_ref?: MemoryEvidenceRef;
}

export interface PublicationTarget {
  readonly target_id: string;
  readonly target_kind: PublicationTargetKind;
  readonly locator?: string;
  readonly title?: string;
  readonly status?: PublicationTargetStatus;
  readonly subject_locator?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SubjectMemoryAdapterDescriptor {
  readonly type: string;
  readonly provider?: string;
  readonly surface?: string;
  readonly cursor?: string;
}

export interface SubjectMemory {
  readonly kind: "runx.subject-memory.v1";
  readonly adapter: SubjectMemoryAdapterDescriptor;
  readonly subject: SubjectDescriptor;
  readonly entries: readonly SubjectMemoryEntry[];
  readonly decisions: readonly SubjectMemoryDecision[];
  readonly publication_targets: readonly PublicationTarget[];
  readonly source_refs: readonly MemoryEvidenceRef[];
  readonly generated_at?: string;
  readonly watermark?: string;
}

export interface SubjectMemoryFetchRequest {
  readonly subject_kind: string;
  readonly subject_locator: string;
  readonly cursor?: string;
  readonly include_publication_targets?: boolean;
}

export interface RefreshPublicationTargetRequest {
  readonly memory: SubjectMemory;
  readonly target: PublicationTarget;
  readonly artifacts?: readonly MemoryEvidenceRef[];
  readonly next_status?: PublicationTargetStatus;
}

export interface SubjectMemoryAdapter {
  readonly type: string;
  readonly fetchSubjectMemory: (request: SubjectMemoryFetchRequest) => Promise<SubjectMemory>;
  readonly refreshPublicationTarget?: (
    request: RefreshPublicationTargetRequest,
  ) => Promise<PublicationTarget>;
}

export function validateSubjectMemory(value: unknown, label = "subject_memory"): SubjectMemory {
  const record = requireRecord(value, label);
  if (record.kind !== "runx.subject-memory.v1") {
    throw new Error(`${label}.kind must be "runx.subject-memory.v1" (${MEMORY_SCHEMA_REFS.subject_memory}).`);
  }
  return {
    kind: "runx.subject-memory.v1",
    adapter: validateSubjectMemoryAdapterDescriptor(record.adapter, `${label}.adapter`),
    subject: validateSubjectDescriptor(record.subject, `${label}.subject`),
    entries: requireArray(record.entries, `${label}.entries`).map((entry, index) =>
      validateSubjectMemoryEntry(entry, `${label}.entries[${index}]`),
    ),
    decisions: requireArray(record.decisions, `${label}.decisions`).map((decision, index) =>
      validateSubjectMemoryDecision(decision, `${label}.decisions[${index}]`),
    ),
    publication_targets: requireArray(record.publication_targets, `${label}.publication_targets`).map((target, index) =>
      validatePublicationTarget(target, `${label}.publication_targets[${index}]`),
    ),
    source_refs: requireArray(record.source_refs, `${label}.source_refs`).map((ref, index) =>
      validateMemoryEvidenceRef(ref, `${label}.source_refs[${index}]`),
    ),
    generated_at: optionalDateTime(record.generated_at, `${label}.generated_at`),
    watermark: optionalString(record.watermark, `${label}.watermark`),
  };
}

export function validatePublicationTarget(value: unknown, label = "publication_target"): PublicationTarget {
  const record = requireRecord(value, label);
  return {
    target_id: requireString(record.target_id, `${label}.target_id`),
    target_kind: requireEnum(
      record.target_kind,
      ["pull_request", "draft_change", "patch_bundle", "message", "artifact"],
      `${label}.target_kind`,
    ),
    locator: optionalString(record.locator, `${label}.locator`),
    title: optionalString(record.title, `${label}.title`),
    status: optionalEnum(
      record.status,
      ["proposed", "draft", "published", "superseded", "closed"],
      `${label}.status`,
    ),
    subject_locator: optionalString(record.subject_locator, `${label}.subject_locator`),
    metadata: optionalPlainRecord(record.metadata, `${label}.metadata`),
  };
}

export function validateSubjectMemoryDecision(
  value: unknown,
  label = "subject_memory_decision",
): SubjectMemoryDecision {
  const record = requireRecord(value, label);
  return {
    decision_id: requireString(record.decision_id, `${label}.decision_id`),
    gate_id: requireString(record.gate_id, `${label}.gate_id`),
    decision: requireEnum(record.decision, ["allow", "deny"], `${label}.decision`),
    recorded_at: requireDateTime(record.recorded_at, `${label}.recorded_at`),
    reason: optionalString(record.reason, `${label}.reason`),
    author: optionalActor(record.author, `${label}.author`),
    source_ref: optionalEvidenceRef(record.source_ref, `${label}.source_ref`),
  };
}

export function validateSubjectMemoryEntry(value: unknown, label = "subject_memory_entry"): SubjectMemoryEntry {
  const record = requireRecord(value, label);
  return {
    entry_id: requireString(record.entry_id, `${label}.entry_id`),
    entry_kind: requireEnum(record.entry_kind, ["message", "decision", "status", "artifact_ref", "note"], `${label}.entry_kind`),
    recorded_at: requireDateTime(record.recorded_at, `${label}.recorded_at`),
    actor: optionalActor(record.actor, `${label}.actor`),
    body: optionalString(record.body, `${label}.body`),
    structured_data: optionalPlainRecord(record.structured_data, `${label}.structured_data`),
    source_ref: optionalEvidenceRef(record.source_ref, `${label}.source_ref`),
    labels: optionalStringArray(record.labels, `${label}.labels`),
    supersedes: optionalStringArray(record.supersedes, `${label}.supersedes`),
  };
}

export function latestDecisionForGate(memory: SubjectMemory, gateId: string): SubjectMemoryDecision | undefined {
  return memory.decisions
    .filter((decision) => decision.gate_id === gateId)
    .slice()
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at))
    .at(-1);
}

export function subjectMemoryAllowsGate(memory: SubjectMemory, gateId: string): boolean {
  return latestDecisionForGate(memory, gateId)?.decision === "allow";
}

export function findPublicationTarget(
  memory: SubjectMemory,
  targetKind: PublicationTargetKind,
): PublicationTarget | undefined {
  return memory.publication_targets.find((target) => target.target_kind === targetKind);
}

export function summarizeSubjectMemory(memory: SubjectMemory): string {
  const subject = `${memory.subject.subject_kind}:${memory.subject.subject_locator}`;
  const entryCount = memory.entries.length;
  const decisionCount = memory.decisions.length;
  const targetKinds = memory.publication_targets.map((target) => target.target_kind).join(", ") || "none";
  return `${subject} via ${memory.adapter.type} | entries=${entryCount} decisions=${decisionCount} publication_targets=${targetKinds}`;
}

export interface LocalMemoryIndex {
  readonly schema_version: "runx.memory.v1";
  readonly receipts: readonly MemoryReceiptRecord[];
  readonly facts: readonly MemoryFactRecord[];
  readonly answers: readonly MemoryAnswerRecord[];
  readonly artifacts: readonly MemoryArtifactRecord[];
}

export interface MemoryReceiptRecord {
  readonly receipt_id: string;
  readonly kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly subject: string;
  readonly source_type?: string;
  readonly receipt_path?: string;
  readonly project?: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly indexed_at: string;
}

export interface MemoryFactRecord {
  readonly id: string;
  readonly project: string;
  readonly scope: string;
  readonly key: string;
  readonly value: unknown;
  readonly source: string;
  readonly confidence: number;
  readonly freshness: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export interface MemoryAnswerRecord {
  readonly id: string;
  readonly project: string;
  readonly question_id: string;
  readonly answer_hash: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export interface MemoryArtifactRecord {
  readonly id: string;
  readonly project: string;
  readonly path: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export interface IndexReceiptOptions {
  readonly receipt: LocalReceipt;
  readonly receiptPath?: string;
  readonly project?: string;
  readonly indexedAt?: string;
}

export interface AddFactOptions {
  readonly project: string;
  readonly scope: string;
  readonly key: string;
  readonly value: unknown;
  readonly source: string;
  readonly confidence: number;
  readonly freshness: string;
  readonly receiptId?: string;
  readonly createdAt?: string;
}

export interface LocalMemoryStore {
  readonly init: () => Promise<LocalMemoryIndex>;
  readonly read: () => Promise<LocalMemoryIndex>;
  readonly indexReceipt: (options: IndexReceiptOptions) => Promise<MemoryReceiptRecord>;
  readonly addFact: (options: AddFactOptions) => Promise<MemoryFactRecord>;
  readonly listFacts: (filter?: { readonly project?: string }) => Promise<readonly MemoryFactRecord[]>;
  readonly listReceipts: (filter?: { readonly project?: string }) => Promise<readonly MemoryReceiptRecord[]>;
}

export function createFileMemoryStore(memoryDir: string): LocalMemoryStore {
  const indexPath = path.join(memoryDir, "index.json");
  const lockPath = path.join(memoryDir, "index.lock");

  async function read(): Promise<LocalMemoryIndex> {
    try {
      return normalizeIndex(JSON.parse(await readFile(indexPath, "utf8")) as unknown);
    } catch (error) {
      if (isNotFound(error)) {
        return emptyIndex();
      }
      throw error;
    }
  }

  async function writeUnlocked(index: LocalMemoryIndex): Promise<void> {
    await mkdir(memoryDir, { recursive: true });
    const tempPath = path.join(memoryDir, `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, indexPath);
  }

  async function updateIndex<T>(updater: (index: LocalMemoryIndex) => Promise<{ readonly index: LocalMemoryIndex; readonly result: T }>): Promise<T> {
    return await withIndexLock(memoryDir, lockPath, async () => {
      const current = await read();
      const { index, result } = await updater(current);
      await writeUnlocked(index);
      return result;
    });
  }

  return {
    init: async () => {
      return await updateIndex(async (index) => ({ index, result: index }));
    },
    read,
    indexReceipt: async (options) => {
      return await updateIndex(async (index) => {
        const record = receiptRecord(options);
        return {
          result: record,
          index: {
            ...index,
            receipts: [...index.receipts.filter((candidate) => candidate.receipt_id !== record.receipt_id), record],
          },
        };
      });
    },
    addFact: async (options) => {
      return await updateIndex(async (index) => {
        const createdAt = options.createdAt ?? new Date().toISOString();
        const record: MemoryFactRecord = {
          id: `fact_${hashStable({
            project: options.project,
            scope: options.scope,
            key: options.key,
            receipt_id: options.receiptId,
            created_at: createdAt,
          }).slice(0, 24)}`,
          project: options.project,
          scope: options.scope,
          key: options.key,
          value: options.value,
          source: options.source,
          confidence: options.confidence,
          freshness: options.freshness,
          receipt_id: options.receiptId,
          created_at: createdAt,
        };
        return {
          result: record,
          index: {
            ...index,
            facts: [...index.facts.filter((candidate) => candidate.id !== record.id), record],
          },
        };
      });
    },
    listFacts: async (filter) => {
      const index = await read();
      const project = filter?.project;
      return project ? index.facts.filter((fact) => sameProject(fact.project, project)) : index.facts;
    },
    listReceipts: async (filter) => {
      const index = await read();
      const project = filter?.project;
      return project
        ? index.receipts.filter((receipt) => typeof receipt.project === "string" && sameProject(receipt.project, project))
        : index.receipts;
    },
  };
}

async function withIndexLock<T>(memoryDir: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(memoryDir, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() - startedAt > 10_000) {
        throw new Error(`Timed out waiting for local memory lock at ${lockPath}.`);
      }
      await delay(10 + Math.floor(Math.random() * 50));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const details = await stat(lockPath);
    if (Date.now() - details.mtimeMs > 30_000) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function receiptRecord(options: IndexReceiptOptions): MemoryReceiptRecord {
  const receipt = options.receipt;
  return {
    receipt_id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    subject: receipt.kind === "skill_execution" ? receipt.subject.skill_name : receipt.subject.chain_name,
    source_type: receipt.kind === "skill_execution" ? receipt.subject.source_type : undefined,
    receipt_path: options.receiptPath,
    project: options.project ? path.resolve(options.project) : undefined,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    indexed_at: options.indexedAt ?? new Date().toISOString(),
  };
}

function emptyIndex(): LocalMemoryIndex {
  return {
    schema_version: "runx.memory.v1",
    receipts: [],
    facts: [],
    answers: [],
    artifacts: [],
  };
}

function normalizeIndex(value: unknown): LocalMemoryIndex {
  if (!isRecord(value) || value.schema_version !== "runx.memory.v1") {
    return emptyIndex();
  }
  return {
    schema_version: "runx.memory.v1",
    receipts: normalizeArray(value.receipts, isMemoryReceiptRecord, "receipts"),
    facts: normalizeArray(value.facts, isMemoryFactRecord, "facts"),
    answers: normalizeArray(value.answers, isMemoryAnswerRecord, "answers"),
    artifacts: normalizeArray(value.artifacts, isMemoryArtifactRecord, "artifacts"),
  };
}

function normalizeArray<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
  label: string,
): readonly T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: T[] = [];
  for (const entry of value) {
    if (predicate(entry)) {
      normalized.push(entry);
      continue;
    }
    console.warn(`warning: skipping malformed local memory ${label} entry`);
  }
  return normalized;
}

function isMemoryReceiptRecord(value: unknown): value is MemoryReceiptRecord {
  return isRecord(value)
    && typeof value.receipt_id === "string"
    && typeof value.kind === "string"
    && typeof value.status === "string"
    && typeof value.subject === "string"
    && typeof value.indexed_at === "string";
}

function isMemoryFactRecord(value: unknown): value is MemoryFactRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.project === "string"
    && typeof value.scope === "string"
    && typeof value.key === "string"
    && typeof value.source === "string"
    && typeof value.confidence === "number"
    && typeof value.freshness === "string"
    && typeof value.created_at === "string";
}

function isMemoryAnswerRecord(value: unknown): value is MemoryAnswerRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.project === "string"
    && typeof value.question_id === "string"
    && typeof value.answer_hash === "string"
    && typeof value.created_at === "string";
}

function isMemoryArtifactRecord(value: unknown): value is MemoryArtifactRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.project === "string"
    && typeof value.path === "string"
    && typeof value.created_at === "string";
}

function sameProject(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function validateSubjectMemoryAdapterDescriptor(value: unknown, label: string): SubjectMemoryAdapterDescriptor {
  const record = requireRecord(value, label);
  return {
    type: requireString(record.type, `${label}.type`),
    provider: optionalString(record.provider, `${label}.provider`),
    surface: optionalString(record.surface, `${label}.surface`),
    cursor: optionalString(record.cursor, `${label}.cursor`),
  };
}

function validateSubjectDescriptor(value: unknown, label: string): SubjectDescriptor {
  const record = requireRecord(value, label);
  return {
    subject_kind: requireString(record.subject_kind, `${label}.subject_kind`),
    subject_locator: requireString(record.subject_locator, `${label}.subject_locator`),
    title: optionalString(record.title, `${label}.title`),
    canonical_uri: optionalString(record.canonical_uri, `${label}.canonical_uri`),
    aliases: optionalStringArray(record.aliases, `${label}.aliases`),
    metadata: optionalPlainRecord(record.metadata, `${label}.metadata`),
  };
}

function validateMemoryEvidenceRef(value: unknown, label: string): MemoryEvidenceRef {
  const record = requireRecord(value, label);
  return {
    type: requireString(record.type, `${label}.type`),
    uri: requireString(record.uri, `${label}.uri`),
    label: optionalString(record.label, `${label}.label`),
    recorded_at: optionalDateTime(record.recorded_at, `${label}.recorded_at`),
  };
}

function optionalActor(value: unknown, label: string): MemoryActor | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, label);
  return {
    actor_id: optionalString(record.actor_id, `${label}.actor_id`),
    display_name: optionalString(record.display_name, `${label}.display_name`),
    role: optionalString(record.role, `${label}.role`),
    provider_identity: optionalString(record.provider_identity, `${label}.provider_identity`),
  };
}

function optionalEvidenceRef(value: unknown, label: string): MemoryEvidenceRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateMemoryEvidenceRef(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function requireDateTime(value: unknown, label: string): string {
  const stringValue = requireString(value, label);
  if (Number.isNaN(Date.parse(stringValue))) {
    throw new Error(`${label} must be an ISO datetime string.`);
  }
  return stringValue;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, label);
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireEnum(value, allowed, label);
}

function optionalDateTime(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireDateTime(value, label);
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function optionalPlainRecord(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, label);
}
