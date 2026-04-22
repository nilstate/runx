export const memoryPackage = "@runx/memory";

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LocalReceipt } from "../../receipts/src/index.js";

export const RUNX_SCHEMA_REFS = {
  subject_memory: "https://runx.ai/spec/subject-memory.schema.json",
  outbox_entry: "https://runx.ai/spec/outbox-entry.schema.json",
  subject_memory_decision: "https://runx.ai/spec/subject-memory-decision.schema.json",
  journal_entry: "https://runx.ai/spec/journal-entry.schema.json",
} as const;

export type SubjectMemoryEntryKind = "message" | "decision" | "status" | "artifact_ref" | "note";
export type SubjectMemoryDecisionValue = "allow" | "deny";
export type OutboxEntryKind = "pull_request" | "draft_change" | "patch_bundle" | "message" | "artifact";
export type OutboxEntryStatus = "proposed" | "draft" | "published" | "superseded" | "closed";

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

export interface OutboxEntry {
  readonly entry_id: string;
  readonly kind: OutboxEntryKind;
  readonly locator?: string;
  readonly title?: string;
  readonly status?: OutboxEntryStatus;
  readonly subject_locator?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SubjectMemoryAdapterDescriptor {
  readonly type: string;
  readonly provider?: string;
  readonly surface?: string;
  readonly cursor?: string;
  readonly adapter_ref?: string;
}

export interface SubjectMemory {
  readonly kind: "runx.subject-memory.v1";
  readonly adapter: SubjectMemoryAdapterDescriptor;
  readonly subject: SubjectDescriptor;
  readonly entries: readonly SubjectMemoryEntry[];
  readonly decisions: readonly SubjectMemoryDecision[];
  readonly subject_outbox: readonly OutboxEntry[];
  readonly source_refs: readonly MemoryEvidenceRef[];
  readonly generated_at?: string;
  readonly watermark?: string;
}

export interface SubjectMemoryFetchRequest {
  readonly subject_kind: string;
  readonly subject_locator: string;
  readonly cursor?: string;
  readonly include_subject_outbox?: boolean;
}

export interface PushOutboxEntryRequest {
  readonly memory: SubjectMemory;
  readonly entry: OutboxEntry;
  readonly artifacts?: readonly MemoryEvidenceRef[];
  readonly next_status?: OutboxEntryStatus;
}

export interface SubjectMemoryAdapter {
  readonly type: string;
  readonly fetchSubjectMemory: (request: SubjectMemoryFetchRequest) => Promise<SubjectMemory>;
  readonly push?: (request: PushOutboxEntryRequest) => Promise<OutboxEntry>;
}

export interface PushOutboxEntryResult {
  readonly status: "pushed" | "skipped";
  readonly reason?: string;
  readonly outbox_entry: OutboxEntry;
  readonly subject_memory: SubjectMemory;
}

export function validateSubjectMemory(value: unknown, label = "subject_memory"): SubjectMemory {
  const record = requireRecord(value, label);
  if (record.kind !== "runx.subject-memory.v1") {
    throw new Error(`${label}.kind must be "runx.subject-memory.v1" (${RUNX_SCHEMA_REFS.subject_memory}).`);
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
    subject_outbox: requireArray(record.subject_outbox, `${label}.subject_outbox`).map((entry, index) =>
      validateOutboxEntry(entry, `${label}.subject_outbox[${index}]`),
    ),
    source_refs: requireArray(record.source_refs, `${label}.source_refs`).map((ref, index) =>
      validateMemoryEvidenceRef(ref, `${label}.source_refs[${index}]`),
    ),
    generated_at: optionalDateTime(record.generated_at, `${label}.generated_at`),
    watermark: optionalString(record.watermark, `${label}.watermark`),
  };
}

export function validateOutboxEntry(value: unknown, label = "outbox_entry"): OutboxEntry {
  const record = requireRecord(value, label);
  return {
    entry_id: requireString(record.entry_id, `${label}.entry_id`),
    kind: requireEnum(
      record.kind,
      ["pull_request", "draft_change", "patch_bundle", "message", "artifact"],
      `${label}.kind`,
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

export function findOutboxEntry(
  memory: SubjectMemory,
  kind: OutboxEntryKind,
): OutboxEntry | undefined {
  return memory.subject_outbox.find((entry) => entry.kind === kind);
}

export function createSubjectMemoryAdapter(
  descriptor: SubjectMemoryAdapterDescriptor,
): SubjectMemoryAdapter | undefined {
  switch (descriptor.type) {
    case "file":
    case "file_subject_memory":
      return createFileSubjectMemoryAdapter(descriptor);
    default:
      return undefined;
  }
}

export async function pushOutboxEntryViaAdapter(
  request: PushOutboxEntryRequest,
): Promise<PushOutboxEntryResult> {
  const adapter = createSubjectMemoryAdapter(request.memory.adapter);
  if (!adapter) {
    return {
      status: "skipped",
      reason: `no subject memory adapter is registered for '${request.memory.adapter.type}'`,
      outbox_entry: request.entry,
      subject_memory: request.memory,
    };
  }
  if (!adapter.push) {
    return {
      status: "skipped",
      reason: `subject memory adapter '${adapter.type}' does not support push`,
      outbox_entry: request.entry,
      subject_memory: request.memory,
    };
  }

  const outboxEntry = await adapter.push(request);
  const subjectMemory = await adapter.fetchSubjectMemory({
    subject_kind: request.memory.subject.subject_kind,
    subject_locator: request.memory.subject.subject_locator,
    cursor: request.memory.adapter.cursor,
    include_subject_outbox: true,
  });
  return {
    status: "pushed",
    outbox_entry: outboxEntry,
    subject_memory: subjectMemory,
  };
}

export function summarizeSubjectMemory(memory: SubjectMemory): string {
  const subject = `${memory.subject.subject_kind}:${memory.subject.subject_locator}`;
  const entryCount = memory.entries.length;
  const decisionCount = memory.decisions.length;
  const outboxKinds = memory.subject_outbox.map((entry) => entry.kind).join(", ") || "none";
  return `${subject} via ${memory.adapter.type} | entries=${entryCount} decisions=${decisionCount} outbox=${outboxKinds}`;
}

export type LocalJournalEntryKind = "receipt" | "fact" | "answer" | "artifact";

export interface LocalJournalReceiptEntry {
  readonly entry_id: string;
  readonly entry_kind: "receipt";
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

export interface LocalJournalFactEntry {
  readonly entry_id: string;
  readonly entry_kind: "fact";
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

export interface LocalJournalAnswerEntry {
  readonly entry_id: string;
  readonly entry_kind: "answer";
  readonly project: string;
  readonly question_id: string;
  readonly answer_hash: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export interface LocalJournalArtifactEntry {
  readonly entry_id: string;
  readonly entry_kind: "artifact";
  readonly project: string;
  readonly path: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export type LocalJournalEntry =
  | LocalJournalReceiptEntry
  | LocalJournalFactEntry
  | LocalJournalAnswerEntry
  | LocalJournalArtifactEntry;

export interface LocalJournal {
  readonly schema_version: "runx.journal.v1";
  readonly entries: readonly LocalJournalEntry[];
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

export interface LocalJournalStore {
  readonly init: () => Promise<LocalJournal>;
  readonly read: () => Promise<LocalJournal>;
  readonly indexReceipt: (options: IndexReceiptOptions) => Promise<LocalJournalReceiptEntry>;
  readonly addFact: (options: AddFactOptions) => Promise<LocalJournalFactEntry>;
  readonly listFacts: (filter?: { readonly project?: string }) => Promise<readonly LocalJournalFactEntry[]>;
  readonly listReceipts: (filter?: { readonly project?: string }) => Promise<readonly LocalJournalReceiptEntry[]>;
}

export function createFileJournalStore(journalDir: string): LocalJournalStore {
  const indexPath = path.join(journalDir, "index.json");
  const lockPath = path.join(journalDir, "index.lock");

  async function read(): Promise<LocalJournal> {
    try {
      return normalizeJournal(JSON.parse(await readFile(indexPath, "utf8")) as unknown);
    } catch (error) {
      if (isNotFound(error)) {
        return emptyJournal();
      }
      throw error;
    }
  }

  async function writeUnlocked(journal: LocalJournal): Promise<void> {
    await mkdir(journalDir, { recursive: true });
    const tempPath = path.join(
      journalDir,
      `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(tempPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, indexPath);
  }

  async function updateJournal<T>(
    updater: (journal: LocalJournal) => Promise<{ readonly journal: LocalJournal; readonly result: T }>,
  ): Promise<T> {
    return await withJournalLock(journalDir, lockPath, async () => {
      const current = await read();
      const { journal, result } = await updater(current);
      await writeUnlocked(journal);
      return result;
    });
  }

  return {
    init: async () => {
      return await updateJournal(async (journal) => ({ journal, result: journal }));
    },
    read,
    indexReceipt: async (options) => {
      return await updateJournal(async (journal) => {
        const entry = receiptEntry(options);
        return {
          result: entry,
          journal: {
            ...journal,
            entries: [
              ...journal.entries.filter((candidate) => !(candidate.entry_kind === "receipt" && candidate.receipt_id === entry.receipt_id)),
              entry,
            ],
          },
        };
      });
    },
    addFact: async (options) => {
      return await updateJournal(async (journal) => {
        const createdAt = options.createdAt ?? new Date().toISOString();
        const entry: LocalJournalFactEntry = {
          entry_id: `fact_${hashStable({
            project: options.project,
            scope: options.scope,
            key: options.key,
            receipt_id: options.receiptId,
            created_at: createdAt,
          }).slice(0, 24)}`,
          entry_kind: "fact",
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
          result: entry,
          journal: {
            ...journal,
            entries: [...journal.entries.filter((candidate) => candidate.entry_id !== entry.entry_id), entry],
          },
        };
      });
    },
    listFacts: async (filter) => {
      const journal = await read();
      const facts = journal.entries.filter(isLocalJournalFactEntry);
      const project = filter?.project;
      return project ? facts.filter((fact) => sameProject(fact.project, project)) : facts;
    },
    listReceipts: async (filter) => {
      const journal = await read();
      const receipts = journal.entries.filter(isLocalJournalReceiptEntry);
      const project = filter?.project;
      return project
        ? receipts.filter((receipt) => typeof receipt.project === "string" && sameProject(receipt.project, project))
        : receipts;
    },
  };
}

async function withJournalLock<T>(journalDir: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(journalDir, { recursive: true });
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
        throw new Error(`Timed out waiting for local journal lock at ${lockPath}.`);
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

function receiptEntry(options: IndexReceiptOptions): LocalJournalReceiptEntry {
  const receipt = options.receipt;
  return {
    entry_id: `receipt_${receipt.id}`,
    entry_kind: "receipt",
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

function emptyJournal(): LocalJournal {
  return {
    schema_version: "runx.journal.v1",
    entries: [],
  };
}

function normalizeJournal(value: unknown): LocalJournal {
  if (!isRecord(value) || value.schema_version !== "runx.journal.v1") {
    return emptyJournal();
  }
  return {
    schema_version: "runx.journal.v1",
    entries: normalizeJournalEntries(value.entries),
  };
}

function normalizeJournalEntries(value: unknown): readonly LocalJournalEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: LocalJournalEntry[] = [];
  for (const entry of value) {
    const normalized = normalizeJournalEntry(entry);
    if (normalized) {
      entries.push(normalized);
      continue;
    }
    console.warn("warning: skipping malformed local journal entry");
  }
  return entries;
}

function normalizeJournalEntry(value: unknown): LocalJournalEntry | undefined {
  if (isLocalJournalReceiptEntry(value)) {
    return value;
  }
  if (isLocalJournalFactEntry(value)) {
    return value;
  }
  if (isLocalJournalAnswerEntry(value)) {
    return value;
  }
  if (isLocalJournalArtifactEntry(value)) {
    return value;
  }
  return undefined;
}

function isLocalJournalReceiptEntry(value: unknown): value is LocalJournalReceiptEntry {
  return isRecord(value)
    && value.entry_kind === "receipt"
    && typeof value.entry_id === "string"
    && typeof value.receipt_id === "string"
    && typeof value.kind === "string"
    && typeof value.status === "string"
    && typeof value.subject === "string"
    && typeof value.indexed_at === "string";
}

function isLocalJournalFactEntry(value: unknown): value is LocalJournalFactEntry {
  return isRecord(value)
    && value.entry_kind === "fact"
    && typeof value.entry_id === "string"
    && typeof value.project === "string"
    && typeof value.scope === "string"
    && typeof value.key === "string"
    && typeof value.source === "string"
    && typeof value.confidence === "number"
    && typeof value.freshness === "string"
    && typeof value.created_at === "string";
}

function isLocalJournalAnswerEntry(value: unknown): value is LocalJournalAnswerEntry {
  return isRecord(value)
    && value.entry_kind === "answer"
    && typeof value.entry_id === "string"
    && typeof value.project === "string"
    && typeof value.question_id === "string"
    && typeof value.answer_hash === "string"
    && typeof value.created_at === "string";
}

function isLocalJournalArtifactEntry(value: unknown): value is LocalJournalArtifactEntry {
  return isRecord(value)
    && value.entry_kind === "artifact"
    && typeof value.entry_id === "string"
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
    adapter_ref: optionalString(record.adapter_ref, `${label}.adapter_ref`),
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

function createFileSubjectMemoryAdapter(
  descriptor: SubjectMemoryAdapterDescriptor,
): SubjectMemoryAdapter {
  const adapterRef = descriptor.adapter_ref;
  if (!adapterRef) {
    throw new Error(`subject memory adapter '${descriptor.type}' requires adapter_ref.`);
  }
  const memoryPath = resolveAdapterRefPath(adapterRef);
  const adapterUri = pathToFileURL(memoryPath).href;

  return {
    type: descriptor.type,
    fetchSubjectMemory: async (request) => {
      const memory = validateSubjectMemory(JSON.parse(await readFile(memoryPath, "utf8")) as unknown);
      if (
        memory.subject.subject_kind !== request.subject_kind
        || memory.subject.subject_locator !== request.subject_locator
      ) {
        throw new Error(
          `subject memory at ${memoryPath} does not match ${request.subject_kind}:${request.subject_locator}.`,
        );
      }
      return request.include_subject_outbox === false
        ? { ...memory, subject_outbox: [] }
        : memory;
    },
    push: async (request) => {
      const current = validateSubjectMemory(JSON.parse(await readFile(memoryPath, "utf8")) as unknown);
      const pushedAt = new Date().toISOString();
      const outboxEntry = normalizePushedOutboxEntry({
        entry: request.entry,
        current,
        nextStatus: request.next_status,
        adapterUri,
      });
      const eventEntry: SubjectMemoryEntry = {
        entry_id: `entry_${hashStable({
          subject: current.subject.subject_locator,
          outbox_entry: outboxEntry.entry_id,
          pushed_at: pushedAt,
        }).slice(0, 24)}`,
        entry_kind: "status",
        recorded_at: pushedAt,
        body: `Pushed ${outboxEntry.kind} ${outboxEntry.entry_id}`,
        structured_data: {
          event: "push_outbox_entry",
          outbox_entry_id: outboxEntry.entry_id,
          kind: outboxEntry.kind,
          locator: outboxEntry.locator,
          status: outboxEntry.status,
        },
        source_ref: {
          type: "subject_memory_adapter",
          uri: adapterUri,
          recorded_at: pushedAt,
        },
      };
      const outboxEntries = upsertOutboxEntry(current.subject_outbox, outboxEntry);
      const nextMemory = validateSubjectMemory({
        ...current,
        adapter: {
          ...current.adapter,
          adapter_ref: current.adapter.adapter_ref ?? adapterUri,
          cursor: `push:${hashStable({ outbox_entry: outboxEntry.entry_id, pushed_at: pushedAt }).slice(0, 12)}`,
        },
        entries: [...current.entries, eventEntry],
        subject_outbox: outboxEntries,
        generated_at: pushedAt,
        watermark: outboxEntry.entry_id,
      });
      await writeSubjectMemoryFile(memoryPath, nextMemory);
      return outboxEntry;
    },
  };
}

function resolveAdapterRefPath(adapterRef: string): string {
  if (adapterRef.startsWith("file://")) {
    return path.resolve(fileURLToPath(adapterRef));
  }
  return path.resolve(adapterRef);
}

function normalizePushedOutboxEntry(options: {
  readonly entry: OutboxEntry;
  readonly current: SubjectMemory;
  readonly nextStatus?: OutboxEntryStatus;
  readonly adapterUri: string;
}): OutboxEntry {
  const { entry, current, nextStatus, adapterUri } = options;
  const existing = current.subject_outbox.find((candidate) =>
    candidate.entry_id === entry.entry_id
    || (typeof entry.locator === "string" && entry.locator.length > 0 && candidate.locator === entry.locator)
    || (
      candidate.kind === entry.kind
      && (candidate.subject_locator ?? current.subject.subject_locator)
        === (entry.subject_locator ?? current.subject.subject_locator)
    )
  );
  return validateOutboxEntry({
    ...existing,
    ...entry,
    locator: entry.locator ?? existing?.locator ?? `${adapterUri}#outbox/${encodeURIComponent(entry.entry_id)}`,
    status: nextStatus ?? entry.status ?? existing?.status ?? "draft",
    subject_locator: entry.subject_locator ?? existing?.subject_locator ?? current.subject.subject_locator,
  });
}

function upsertOutboxEntry(
  subjectOutbox: readonly OutboxEntry[],
  entry: OutboxEntry,
): readonly OutboxEntry[] {
  const filtered = subjectOutbox.filter((candidate) =>
    candidate.entry_id !== entry.entry_id
    && candidate.locator !== entry.locator
    && !(
      candidate.kind === entry.kind
      && (candidate.subject_locator ?? "") === (entry.subject_locator ?? "")
    ),
  );
  return [...filtered, entry];
}

async function writeSubjectMemoryFile(memoryPath: string, memory: SubjectMemory): Promise<void> {
  await mkdir(path.dirname(memoryPath), { recursive: true });
  const tempPath = `${memoryPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, memoryPath);
}
