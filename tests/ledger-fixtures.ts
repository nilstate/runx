import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJsonStringify,
  ledgerCanonicalization,
  ledgerChainSchemaVersion,
  ledgerHashAlgorithm,
  ledgerRecordSchemaVersion,
  sha256Hex,
} from "@runxhq/contracts";

interface ArtifactProducer {
  readonly skill: string;
  readonly runner: string;
}

interface ArtifactEnvelope {
  readonly type: string | null;
  readonly version: "1";
  readonly data: Readonly<Record<string, unknown>>;
  readonly meta: {
    readonly artifact_id: string;
    readonly run_id: string;
    readonly step_id: string | null;
    readonly producer: ArtifactProducer;
    readonly created_at: string;
    readonly hash: string;
    readonly size_bytes: number;
    readonly parent_artifact_id: string | null;
    readonly receipt_id: string | null;
    readonly redacted: boolean;
  };
}

interface LedgerRecord {
  readonly schema_version: typeof ledgerRecordSchemaVersion;
  readonly chain: {
    readonly version: typeof ledgerChainSchemaVersion;
    readonly algorithm: typeof ledgerHashAlgorithm;
    readonly canonicalization: typeof ledgerCanonicalization;
    readonly index: number;
    readonly previous_hash: string | null;
    readonly entry_hash: string;
  };
  readonly entry: ArtifactEnvelope;
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

export async function appendLedgerEntries(options: {
  readonly receiptDir: string;
  readonly runId: string;
  readonly entries: readonly ArtifactEnvelope[];
}): Promise<string> {
  const ledgerPath = resolveLedgerPath(options.receiptDir, options.runId);
  const existing = await readLedgerRecords(ledgerPath);
  let previousHash = existing.at(-1)?.chain.entry_hash ?? null;
  const records = options.entries.map((entry, offset) => {
    const index = existing.length + offset;
    const chain = createLedgerChain(index, previousHash, entry);
    previousHash = chain.entry_hash;
    return {
      schema_version: ledgerRecordSchemaVersion,
      chain,
      entry,
    } satisfies LedgerRecord;
  });

  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await import("node:fs/promises").then(({ appendFile }) =>
    appendFile(ledgerPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8"),
  );
  return ledgerPath;
}

export async function readLedgerEntries(receiptDir: string, runId: string): Promise<readonly ArtifactEnvelope[]> {
  const ledgerPath = resolveLedgerPath(receiptDir, runId);
  return (await readLedgerRecords(ledgerPath)).map((record) => record.entry);
}

export function resolveLedgerPath(receiptDir: string, runId: string): string {
  return path.join(receiptDir, "ledgers", `${runId}.jsonl`);
}

function createArtifactEnvelope(options: {
  readonly type: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly stepId?: string;
  readonly producer: ArtifactProducer;
  readonly createdAt?: string;
}): ArtifactEnvelope {
  const payload = {
    type: options.type,
    version: "1" as const,
    data: options.data,
  };
  const hash = sha256Hex(canonicalJsonStringify(payload));
  return {
    ...payload,
    meta: {
      artifact_id: `ax_${hash.slice(0, 16)}`,
      run_id: options.runId,
      step_id: options.stepId ?? null,
      producer: options.producer,
      created_at: options.createdAt ?? new Date().toISOString(),
      hash,
      size_bytes: Buffer.byteLength(JSON.stringify(options.data), "utf8"),
      parent_artifact_id: null,
      receipt_id: null,
      redacted: false,
    },
  };
}

function createLedgerChain(
  index: number,
  previousHash: string | null,
  entry: ArtifactEnvelope,
): LedgerRecord["chain"] {
  return {
    version: ledgerChainSchemaVersion,
    algorithm: ledgerHashAlgorithm,
    canonicalization: ledgerCanonicalization,
    index,
    previous_hash: previousHash,
    entry_hash: sha256Hex(canonicalJsonStringify({
      version: "runx.ledger.chain-payload.v1",
      index,
      previous_hash: previousHash,
      entry,
    })),
  };
}

async function readLedgerRecords(ledgerPath: string): Promise<readonly LedgerRecord[]> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: LedgerRecord[] = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${ledgerPath}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    records.push(parseLedgerRecord(parsed, `${ledgerPath}:${index + 1}`));
  }
  return records;
}

function parseLedgerRecord(value: unknown, label: string): LedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a ledger record object.`);
  }
  const record = value as Partial<LedgerRecord>;
  if (record.schema_version !== ledgerRecordSchemaVersion) {
    throw new Error(`${label} schema_version must be ${ledgerRecordSchemaVersion}.`);
  }
  if (!record.chain || typeof record.chain !== "object") {
    throw new Error(`${label} chain must be an object.`);
  }
  if (!record.entry || typeof record.entry !== "object") {
    throw new Error(`${label} entry must be an object.`);
  }
  if ((record.entry as { readonly version?: unknown }).version !== "1") {
    throw new Error(`${label} entry.version must be 1.`);
  }
  return record as LedgerRecord;
}
