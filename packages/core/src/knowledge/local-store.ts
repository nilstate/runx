import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalReceipt } from "../receipts/index.js";
import {
  hashStable,
  isAlreadyExists,
  isNotFound,
  isRecord,
} from "./internal-validators.js";

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
