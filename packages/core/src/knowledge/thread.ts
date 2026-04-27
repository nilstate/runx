import {
  optionalDateTime,
  optionalPlainRecord,
  optionalString,
  optionalStringArray,
  requireArray,
  requireDateTime,
  requireEnum,
  requireRecord,
  requireString,
  validateEvidenceRef,
  validateThreadAdapterDescriptor,
  optionalActor,
  optionalEvidenceRef,
  type Actor,
  type EvidenceRef,
  type ThreadAdapterDescriptor,
} from "./internal-validators.js";
import { validateOutboxEntry, type OutboxEntry, type OutboxEntryStatus } from "./outbox.js";

export type { Actor, EvidenceRef, ThreadAdapterDescriptor } from "./internal-validators.js";

export type ThreadEntryKind = "message" | "decision" | "status" | "artifact_ref" | "note";
export type ThreadDecisionValue = "allow" | "deny";

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

const RUNX_THREAD_SCHEMA_REF = "https://runx.ai/spec/thread.schema.json";

export function validateThread(value: unknown, label = "thread"): Thread {
  const record = requireRecord(value, label);
  if (record.kind !== "runx.thread.v1") {
    throw new Error(`${label}.kind must be "runx.thread.v1" (${RUNX_THREAD_SCHEMA_REF}).`);
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

export function summarizeThread(state: Thread): string {
  const threadRef = `${state.thread_kind}:${state.thread_locator}`;
  const entryCount = state.entries.length;
  const decisionCount = state.decisions.length;
  const outboxKinds = state.outbox.map((entry) => entry.kind).join(", ") || "none";
  return `${threadRef} via ${state.adapter.type} | entries=${entryCount} decisions=${decisionCount} outbox=${outboxKinds}`;
}
