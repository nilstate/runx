export const knowledgePackage = "@runxhq/core/knowledge";

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LocalReceipt } from "../receipts/index.js";

export const RUNX_SCHEMA_REFS = {
  thread: "https://runx.ai/spec/thread.schema.json",
  outbox_entry: "https://runx.ai/spec/outbox-entry.schema.json",
  thread_decision: "https://runx.ai/spec/thread-decision.schema.json",
  knowledge_entry: "https://runx.ai/spec@runxhq/core/knowledge-entry.schema.json",
} as const;

export type ThreadEntryKind = "message" | "decision" | "status" | "artifact_ref" | "note";
export type ThreadDecisionValue = "allow" | "deny";
export type OutboxEntryKind = "pull_request" | "draft_change" | "patch_bundle" | "message" | "artifact";
export type OutboxEntryStatus = "proposed" | "draft" | "published" | "superseded" | "closed";

export interface EvidenceRef {
  readonly type: string;
  readonly uri: string;
  readonly label?: string;
  readonly recorded_at?: string;
}

export interface Actor {
  readonly actor_id?: string;
  readonly display_name?: string;
  readonly role?: string;
  readonly provider_identity?: string;
}

export interface ThreadEntry {
  readonly entry_id: string;
  readonly entry_kind: ThreadEntryKind;
  readonly recorded_at: string;
  readonly actor?: Actor;
  readonly body?: string;
  readonly structured_data?: Readonly<Record<string, unknown>>;
  readonly source_ref?: EvidenceRef;
  readonly labels?: readonly string[];
  readonly supersedes?: readonly string[];
}

export interface ThreadDecision {
  readonly decision_id: string;
  readonly gate_id: string;
  readonly decision: ThreadDecisionValue;
  readonly recorded_at: string;
  readonly reason?: string;
  readonly author?: Actor;
  readonly source_ref?: EvidenceRef;
}

export interface OutboxEntry {
  readonly entry_id: string;
  readonly kind: OutboxEntryKind;
  readonly locator?: string;
  readonly title?: string;
  readonly status?: OutboxEntryStatus;
  readonly thread_locator?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ThreadAdapterDescriptor {
  readonly type: string;
  readonly provider?: string;
  readonly surface?: string;
  readonly cursor?: string;
  readonly adapter_ref?: string;
}

export interface Thread {
  readonly kind: "runx.thread.v1";
  readonly adapter: ThreadAdapterDescriptor;
  readonly thread_kind: string;
  readonly thread_locator: string;
  readonly title?: string;
  readonly canonical_uri?: string;
  readonly aliases?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly entries: readonly ThreadEntry[];
  readonly decisions: readonly ThreadDecision[];
  readonly outbox: readonly OutboxEntry[];
  readonly source_refs: readonly EvidenceRef[];
  readonly generated_at?: string;
  readonly watermark?: string;
}

export interface ThreadFetchRequest {
  readonly thread_kind: string;
  readonly thread_locator: string;
  readonly cursor?: string;
  readonly include_outbox?: boolean;
}

export interface PushOutboxEntryRequest {
  readonly thread: Thread;
  readonly entry: OutboxEntry;
  readonly artifacts?: readonly EvidenceRef[];
  readonly next_status?: OutboxEntryStatus;
}

export interface PushOutboxEntryResult {
  readonly status: "pushed" | "skipped";
  readonly reason?: string;
  readonly outbox_entry: OutboxEntry;
  readonly thread: Thread;
}

export function validateThread(value: unknown, label = "thread"): Thread {
  const record = requireRecord(value, label);
  if (record.kind !== "runx.thread.v1") {
    throw new Error(`${label}.kind must be "runx.thread.v1" (${RUNX_SCHEMA_REFS.thread}).`);
  }
  return {
    kind: "runx.thread.v1",
    adapter: validateThreadAdapterDescriptor(record.adapter, `${label}.adapter`),
    thread_kind: requireString(record.thread_kind, `${label}.thread_kind`),
    thread_locator: requireString(record.thread_locator, `${label}.thread_locator`),
    title: optionalString(record.title, `${label}.title`),
    canonical_uri: optionalString(record.canonical_uri, `${label}.canonical_uri`),
    aliases: optionalStringArray(record.aliases, `${label}.aliases`),
    metadata: optionalPlainRecord(record.metadata, `${label}.metadata`),
    entries: requireArray(record.entries, `${label}.entries`).map((entry, index) =>
      validateThreadEntry(entry, `${label}.entries[${index}]`),
    ),
    decisions: requireArray(record.decisions, `${label}.decisions`).map((decision, index) =>
      validateThreadDecision(decision, `${label}.decisions[${index}]`),
    ),
    outbox: requireArray(record.outbox, `${label}.outbox`).map((entry, index) =>
      validateOutboxEntry(entry, `${label}.outbox[${index}]`),
    ),
    source_refs: requireArray(record.source_refs, `${label}.source_refs`).map((ref, index) =>
      validateEvidenceRef(ref, `${label}.source_refs[${index}]`),
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
    thread_locator: optionalString(record.thread_locator, `${label}.thread_locator`),
    metadata: optionalPlainRecord(record.metadata, `${label}.metadata`),
  };
}

export function validateThreadDecision(
  value: unknown,
  label = "thread_decision",
): ThreadDecision {
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

export function validateThreadEntry(value: unknown, label = "thread_entry"): ThreadEntry {
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

export function latestDecisionForGate(state: Thread, gateId: string): ThreadDecision | undefined {
  return state.decisions
    .filter((decision) => decision.gate_id === gateId)
    .slice()
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at))
    .at(-1);
}

export function threadAllowsGate(state: Thread, gateId: string): boolean {
  return latestDecisionForGate(state, gateId)?.decision === "allow";
}

export function findOutboxEntry(
  state: Thread,
  kind: OutboxEntryKind,
): OutboxEntry | undefined {
  return state.outbox.find((entry) => entry.kind === kind);
}

export async function fetchThreadViaAdapter(
  descriptor: ThreadAdapterDescriptor,
  request: ThreadFetchRequest,
): Promise<Thread | undefined> {
  switch (descriptor.type) {
    case "file":
      return await fetchFileThread(descriptor, request);
    default:
      return undefined;
  }
}

export async function pushOutboxEntryViaAdapter(
  request: PushOutboxEntryRequest,
): Promise<PushOutboxEntryResult> {
  if (request.thread.adapter.type !== "file") {
    return {
      status: "skipped",
      reason: `no thread adapter is registered for '${request.thread.adapter.type}'`,
      outbox_entry: request.entry,
      thread: request.thread,
    };
  }

  const outboxEntry = await pushFileThread(request);
  const thread = await fetchThreadViaAdapter(request.thread.adapter, {
    thread_kind: request.thread.thread_kind,
    thread_locator: request.thread.thread_locator,
    cursor: request.thread.adapter.cursor,
    include_outbox: true,
  });
  return {
    status: "pushed",
    outbox_entry: outboxEntry,
    thread: thread ?? request.thread,
  };
}

export function summarizeThread(state: Thread): string {
  const threadRef = `${state.thread_kind}:${state.thread_locator}`;
  const entryCount = state.entries.length;
  const decisionCount = state.decisions.length;
  const outboxKinds = state.outbox.map((entry) => entry.kind).join(", ") || "none";
  return `${threadRef} via ${state.adapter.type} | entries=${entryCount} decisions=${decisionCount} outbox=${outboxKinds}`;
}

export type LocalKnowledgeEntryKind = "receipt" | "projection" | "answer" | "artifact";

export interface LocalKnowledgeReceiptEntry {
  readonly entry_id: string;
  readonly entry_kind: "receipt";
  readonly receipt_id: string;
  readonly kind: LocalReceipt["kind"];
  readonly status: LocalReceipt["status"];
  readonly execution_ref: string;
  readonly source_type?: string;
  readonly receipt_path?: string;
  readonly project?: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly indexed_at: string;
}

export interface LocalKnowledgeProjectionEntry {
  readonly entry_id: string;
  readonly entry_kind: "projection";
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

export interface LocalKnowledgeAnswerEntry {
  readonly entry_id: string;
  readonly entry_kind: "answer";
  readonly project: string;
  readonly question_id: string;
  readonly answer_hash: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export interface LocalKnowledgeArtifactEntry {
  readonly entry_id: string;
  readonly entry_kind: "artifact";
  readonly project: string;
  readonly path: string;
  readonly receipt_id?: string;
  readonly created_at: string;
}

export type LocalKnowledgeEntry =
  | LocalKnowledgeReceiptEntry
  | LocalKnowledgeProjectionEntry
  | LocalKnowledgeAnswerEntry
  | LocalKnowledgeArtifactEntry;

export interface LocalKnowledge {
  readonly schema_version: "runx.knowledge.v1";
  readonly entries: readonly LocalKnowledgeEntry[];
}

export interface IndexReceiptOptions {
  readonly receipt: LocalReceipt;
  readonly receiptPath?: string;
  readonly project?: string;
  readonly indexedAt?: string;
}

export interface AddProjectionOptions {
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

export interface LocalKnowledgeStore {
  readonly init: () => Promise<LocalKnowledge>;
  readonly read: () => Promise<LocalKnowledge>;
  readonly indexReceipt: (options: IndexReceiptOptions) => Promise<LocalKnowledgeReceiptEntry>;
  readonly addProjection: (options: AddProjectionOptions) => Promise<LocalKnowledgeProjectionEntry>;
  readonly listProjections: (filter?: { readonly project?: string }) => Promise<readonly LocalKnowledgeProjectionEntry[]>;
  readonly listReceipts: (filter?: { readonly project?: string }) => Promise<readonly LocalKnowledgeReceiptEntry[]>;
}

export function createFileKnowledgeStore(knowledgeDir: string): LocalKnowledgeStore {
  const indexPath = path.join(knowledgeDir, "index.json");
  const lockPath = path.join(knowledgeDir, "index.lock");

  async function read(): Promise<LocalKnowledge> {
    try {
      return normalizeKnowledge(JSON.parse(await readFile(indexPath, "utf8")) as unknown);
    } catch (error) {
      if (isNotFound(error)) {
        return emptyKnowledge();
      }
      throw error;
    }
  }

  async function writeUnlocked(knowledge: LocalKnowledge): Promise<void> {
    await mkdir(knowledgeDir, { recursive: true });
    const tempPath = path.join(
      knowledgeDir,
      `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(tempPath, `${JSON.stringify(knowledge, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, indexPath);
  }

  async function updateKnowledge<T>(
    updater: (knowledge: LocalKnowledge) => Promise<{ readonly knowledge: LocalKnowledge; readonly result: T }>,
  ): Promise<T> {
    return await withKnowledgeLock(knowledgeDir, lockPath, async () => {
      const current = await read();
      const { knowledge, result } = await updater(current);
      await writeUnlocked(knowledge);
      return result;
    });
  }

  return {
    init: async () => {
      return await updateKnowledge(async (knowledge) => ({ knowledge, result: knowledge }));
    },
    read,
    indexReceipt: async (options) => {
      return await updateKnowledge(async (knowledge) => {
        const entry = receiptEntry(options);
        return {
          result: entry,
          knowledge: {
            ...knowledge,
            entries: [
              ...knowledge.entries.filter((candidate) => !(candidate.entry_kind === "receipt" && candidate.receipt_id === entry.receipt_id)),
              entry,
            ],
          },
        };
      });
    },
    addProjection: async (options) => {
      return await updateKnowledge(async (knowledge) => {
        const createdAt = options.createdAt ?? new Date().toISOString();
        const entry: LocalKnowledgeProjectionEntry = {
          entry_id: `projection_${hashStable({
            project: options.project,
            scope: options.scope,
            key: options.key,
            receipt_id: options.receiptId,
            created_at: createdAt,
          }).slice(0, 24)}`,
          entry_kind: "projection",
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
          knowledge: {
            ...knowledge,
            entries: [...knowledge.entries.filter((candidate) => candidate.entry_id !== entry.entry_id), entry],
          },
        };
      });
    },
    listProjections: async (filter) => {
      const knowledge = await read();
      const projections = knowledge.entries.filter(isLocalKnowledgeProjectionEntry);
      const project = filter?.project;
      return project ? projections.filter((projection) => sameProject(projection.project, project)) : projections;
    },
    listReceipts: async (filter) => {
      const knowledge = await read();
      const receipts = knowledge.entries.filter(isLocalKnowledgeReceiptEntry);
      const project = filter?.project;
      return project
        ? receipts.filter((receipt) => typeof receipt.project === "string" && sameProject(receipt.project, project))
        : receipts;
    },
  };
}

async function withKnowledgeLock<T>(knowledgeDir: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(knowledgeDir, { recursive: true });
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
        throw new Error(`Timed out waiting for local knowledge lock at ${lockPath}.`);
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

function receiptEntry(options: IndexReceiptOptions): LocalKnowledgeReceiptEntry {
  const receipt = options.receipt;
  return {
    entry_id: `receipt_${receipt.id}`,
    entry_kind: "receipt",
    receipt_id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    execution_ref: receipt.kind === "skill_execution" ? receipt.skill_name : receipt.graph_name,
    source_type: receipt.kind === "skill_execution" ? receipt.source_type : undefined,
    receipt_path: options.receiptPath,
    project: options.project ? path.resolve(options.project) : undefined,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    indexed_at: options.indexedAt ?? new Date().toISOString(),
  };
}

function emptyKnowledge(): LocalKnowledge {
  return {
    schema_version: "runx.knowledge.v1",
    entries: [],
  };
}

function normalizeKnowledge(value: unknown): LocalKnowledge {
  if (!isRecord(value) || value.schema_version !== "runx.knowledge.v1") {
    return emptyKnowledge();
  }
  return {
    schema_version: "runx.knowledge.v1",
    entries: normalizeKnowledgeEntries(value.entries),
  };
}

function normalizeKnowledgeEntries(value: unknown): readonly LocalKnowledgeEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: LocalKnowledgeEntry[] = [];
  for (const entry of value) {
    const normalized = normalizeKnowledgeEntry(entry);
    if (normalized) {
      entries.push(normalized);
      continue;
    }
    console.warn("warning: skipping malformed local knowledge entry");
  }
  return entries;
}

function normalizeKnowledgeEntry(value: unknown): LocalKnowledgeEntry | undefined {
  if (isLocalKnowledgeReceiptEntry(value)) {
    return value;
  }
  if (isLocalKnowledgeProjectionEntry(value)) {
    return value;
  }
  if (isLocalKnowledgeAnswerEntry(value)) {
    return value;
  }
  if (isLocalKnowledgeArtifactEntry(value)) {
    return value;
  }
  return undefined;
}

function isLocalKnowledgeReceiptEntry(value: unknown): value is LocalKnowledgeReceiptEntry {
  return isRecord(value)
    && value.entry_kind === "receipt"
    && typeof value.entry_id === "string"
    && typeof value.receipt_id === "string"
    && typeof value.kind === "string"
    && typeof value.status === "string"
    && typeof value.execution_ref === "string"
    && typeof value.indexed_at === "string";
}

function isLocalKnowledgeProjectionEntry(value: unknown): value is LocalKnowledgeProjectionEntry {
  return isRecord(value)
    && value.entry_kind === "projection"
    && typeof value.entry_id === "string"
    && typeof value.project === "string"
    && typeof value.scope === "string"
    && typeof value.key === "string"
    && typeof value.source === "string"
    && typeof value.confidence === "number"
    && typeof value.freshness === "string"
    && typeof value.created_at === "string";
}

function isLocalKnowledgeAnswerEntry(value: unknown): value is LocalKnowledgeAnswerEntry {
  return isRecord(value)
    && value.entry_kind === "answer"
    && typeof value.entry_id === "string"
    && typeof value.project === "string"
    && typeof value.question_id === "string"
    && typeof value.answer_hash === "string"
    && typeof value.created_at === "string";
}

function isLocalKnowledgeArtifactEntry(value: unknown): value is LocalKnowledgeArtifactEntry {
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

function validateThreadAdapterDescriptor(value: unknown, label: string): ThreadAdapterDescriptor {
  const record = requireRecord(value, label);
  return {
    type: requireString(record.type, `${label}.type`),
    provider: optionalString(record.provider, `${label}.provider`),
    surface: optionalString(record.surface, `${label}.surface`),
    cursor: optionalString(record.cursor, `${label}.cursor`),
    adapter_ref: optionalString(record.adapter_ref, `${label}.adapter_ref`),
  };
}

function validateEvidenceRef(value: unknown, label: string): EvidenceRef {
  const record = requireRecord(value, label);
  return {
    type: requireString(record.type, `${label}.type`),
    uri: requireString(record.uri, `${label}.uri`),
    label: optionalString(record.label, `${label}.label`),
    recorded_at: optionalDateTime(record.recorded_at, `${label}.recorded_at`),
  };
}

function optionalActor(value: unknown, label: string): Actor | undefined {
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

function optionalEvidenceRef(value: unknown, label: string): EvidenceRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateEvidenceRef(value, label);
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

async function fetchFileThread(
  descriptor: ThreadAdapterDescriptor,
  request: ThreadFetchRequest,
): Promise<Thread> {
  const adapterRef = descriptor.adapter_ref;
  if (!adapterRef) {
    throw new Error(`thread adapter '${descriptor.type}' requires adapter_ref.`);
  }
  const statePath = resolveAdapterRefPath(adapterRef);
  const state = validateThread(JSON.parse(await readFile(statePath, "utf8")) as unknown);
  if (
    state.thread_kind !== request.thread_kind
    || state.thread_locator !== request.thread_locator
  ) {
    throw new Error(
      `thread at ${statePath} does not match ${request.thread_kind}:${request.thread_locator}.`,
    );
  }
  return request.include_outbox === false
    ? { ...state, outbox: [] }
    : state;
}

async function pushFileThread(request: PushOutboxEntryRequest): Promise<OutboxEntry> {
  const adapterRef = request.thread.adapter.adapter_ref;
  if (!adapterRef) {
    throw new Error(`thread adapter '${request.thread.adapter.type}' requires adapter_ref.`);
  }
  const statePath = resolveAdapterRefPath(adapterRef);
  const adapterUri = pathToFileURL(statePath).href;
  const current = validateThread(JSON.parse(await readFile(statePath, "utf8")) as unknown);
  const pushedAt = new Date().toISOString();
  const outboxEntry = normalizePushedOutboxEntry({
    entry: request.entry,
    current,
    nextStatus: request.next_status,
    adapterUri,
  });
  const eventEntry: ThreadEntry = {
    entry_id: `entry_${hashStable({
      thread: current.thread_locator,
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
      type: "thread_adapter",
      uri: adapterUri,
      recorded_at: pushedAt,
    },
  };
  const outboxEntries = upsertOutboxEntry(current.outbox, outboxEntry);
  const nextState = validateThread({
    ...current,
    adapter: {
      ...current.adapter,
      adapter_ref: current.adapter.adapter_ref ?? adapterUri,
      cursor: `push:${hashStable({ outbox_entry: outboxEntry.entry_id, pushed_at: pushedAt }).slice(0, 12)}`,
    },
    entries: [...current.entries, eventEntry],
    outbox: outboxEntries,
    generated_at: pushedAt,
    watermark: outboxEntry.entry_id,
  });
  await writeThreadFile(statePath, nextState);
  return outboxEntry;
}

function resolveAdapterRefPath(adapterRef: string): string {
  if (adapterRef.startsWith("file://")) {
    return path.resolve(fileURLToPath(adapterRef));
  }
  return path.resolve(adapterRef);
}

function normalizePushedOutboxEntry(options: {
  readonly entry: OutboxEntry;
  readonly current: Thread;
  readonly nextStatus?: OutboxEntryStatus;
  readonly adapterUri: string;
}): OutboxEntry {
  const { entry, current, nextStatus, adapterUri } = options;
  const existing = current.outbox.find((candidate) =>
    candidate.entry_id === entry.entry_id
    || (typeof entry.locator === "string" && entry.locator.length > 0 && candidate.locator === entry.locator)
    || (
      candidate.kind === entry.kind
      && (candidate.thread_locator ?? current.thread_locator)
        === (entry.thread_locator ?? current.thread_locator)
    )
  );
  return validateOutboxEntry({
    ...existing,
    ...entry,
    locator: entry.locator ?? existing?.locator ?? `${adapterUri}#outbox/${encodeURIComponent(entry.entry_id)}`,
    status: nextStatus ?? entry.status ?? existing?.status ?? "draft",
    thread_locator: entry.thread_locator ?? existing?.thread_locator ?? current.thread_locator,
  });
}

function upsertOutboxEntry(
  outbox: readonly OutboxEntry[],
  entry: OutboxEntry,
): readonly OutboxEntry[] {
  const filtered = outbox.filter((candidate) =>
    candidate.entry_id !== entry.entry_id
    && candidate.locator !== entry.locator
    && !(
      candidate.kind === entry.kind
      && (candidate.thread_locator ?? "") === (entry.thread_locator ?? "")
    ),
  );
  return [...filtered, entry];
}

async function writeThreadFile(statePath: string, state: Thread): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, statePath);
}
