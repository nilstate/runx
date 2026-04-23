export const artifactsPackage = "@runxhq/core/artifacts";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  const ledgerPath = resolveLedgerPath(options.receiptDir, options.runId);
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const contents = options.entries.map((entry) => JSON.stringify(entry)).join("\n");
  if (contents.length === 0) {
    return ledgerPath;
  }
  await writeFile(ledgerPath, `${contents}\n`, { flag: "a" });
  return ledgerPath;
}

export async function readLedgerEntries(receiptDir: string, runId: string): Promise<readonly ArtifactEnvelope[]> {
  const ledgerPath = resolveLedgerPath(receiptDir, runId);
  let contents = "";
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch {
    return [];
  }
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ArtifactEnvelope);
}

export function resolveLedgerPath(receiptDir: string, runId: string): string {
  return path.join(receiptDir, "ledgers", `${runId}.jsonl`);
}

export function hashStable(value: unknown): string {
  return hashString(stableStringify(value));
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
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
