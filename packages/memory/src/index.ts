export const memoryPackage = "@runx/memory";

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type { LocalReceipt } from "../../receipts/src/index.js";

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
