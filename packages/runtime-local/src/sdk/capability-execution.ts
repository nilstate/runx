export const capabilityExecutionSdkPackage = "@runxhq/runtime-local/sdk/capability-execution";

import { createHash } from "node:crypto";

import {
  validateCapabilityExecutionContract,
  type CapabilityExecutionActorContract,
  type CapabilityExecutionContract,
  type CapabilityExecutionTransportContract,
} from "@runxhq/contracts";

type JsonRecord = Readonly<Record<string, unknown>>;

export interface BuildCapabilityExecutionOptions {
  readonly capabilityRef: string;
  readonly runner: string;
  readonly threadRef?: string;
  readonly requestedAt?: string;
  readonly transportKind?: CapabilityExecutionTransportContract["kind"];
  readonly triggerRef?: string;
  readonly scopeSet?: readonly string[];
  readonly actor?: CapabilityExecutionActorContract;
  readonly inputOverrides?: JsonRecord;
}

export function buildCapabilityExecution(options: BuildCapabilityExecutionOptions): CapabilityExecutionContract {
  const inputOverrides = normalizeCapabilityExecutionRecord(options.inputOverrides);
  const transport = normalizeCapabilityExecutionTransport({
    kind: options.transportKind ?? "cli",
    trigger_ref: options.triggerRef,
    scope_set: options.scopeSet,
    actor: options.actor,
  });
  const threadRef = normalizeNonEmptyString(options.threadRef);
  const requestedAt = normalizeNonEmptyString(options.requestedAt) ?? new Date().toISOString();

  return validateCapabilityExecutionContract(pruneUndefined({
    schema: "runx.capability_execution.v1",
    capability_ref: options.capabilityRef,
    runner: options.runner,
    thread_ref: threadRef,
    requested_at: requestedAt,
    transport,
    input_overrides: inputOverrides,
    idempotency: {
      algorithm: "sha256",
      intent_key: deriveCapabilityExecutionIntentKey({
        capabilityRef: options.capabilityRef,
        runner: options.runner,
        threadRef,
        inputOverrides,
      }),
      trigger_key: deriveCapabilityExecutionTriggerKey({
        transportKind: transport.kind,
        triggerRef: transport.trigger_ref,
      }),
      content_hash: deriveCapabilityExecutionContentHash(inputOverrides),
    },
  }));
}

export function deriveCapabilityExecutionIntentKey(options: {
  readonly capabilityRef: string;
  readonly runner: string;
  readonly threadRef?: string;
  readonly inputOverrides?: JsonRecord;
}): string {
  return withSha256Prefix(hashStableJson({
    capability_ref: options.capabilityRef,
    runner: options.runner,
    thread_ref: normalizeNonEmptyString(options.threadRef),
    input_overrides: normalizeCapabilityExecutionRecord(options.inputOverrides),
  }));
}

export function deriveCapabilityExecutionTriggerKey(options: {
  readonly transportKind: CapabilityExecutionTransportContract["kind"];
  readonly triggerRef?: string;
}): string | undefined {
  const triggerRef = normalizeNonEmptyString(options.triggerRef);
  if (!triggerRef) {
    return undefined;
  }
  return withSha256Prefix(hashStableJson({
    transport_kind: options.transportKind,
    trigger_ref: triggerRef,
  }));
}

export function deriveCapabilityExecutionContentHash(inputOverrides?: JsonRecord): string {
  return withSha256Prefix(hashStableJson(normalizeCapabilityExecutionRecord(inputOverrides) ?? {}));
}

export function normalizeCapabilityExecutionRecord(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeUnknown(value);
  return isRecord(normalized) && Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeCapabilityExecutionTransport(value: {
  readonly kind: CapabilityExecutionTransportContract["kind"];
  readonly trigger_ref?: string;
  readonly scope_set?: readonly string[];
  readonly actor?: CapabilityExecutionActorContract;
}): CapabilityExecutionTransportContract {
  const actor = normalizeCapabilityExecutionActor(value.actor);
  const scopeSet = normalizeStringArray(value.scope_set);
  return pruneUndefined({
    kind: value.kind,
    trigger_ref: normalizeNonEmptyString(value.trigger_ref),
    scope_set: scopeSet.length > 0 ? scopeSet : undefined,
    actor,
  }) as CapabilityExecutionTransportContract;
}

function normalizeCapabilityExecutionActor(value: CapabilityExecutionActorContract | undefined): CapabilityExecutionActorContract | undefined {
  if (!value) {
    return undefined;
  }
  const actor = {
    actor_id: normalizeNonEmptyString(value.actor_id),
    display_name: normalizeNonEmptyString(value.display_name),
    role: normalizeNonEmptyString(value.role),
    provider_identity: normalizeNonEmptyString(value.provider_identity),
  };
  return Object.values(actor).some((entry) => typeof entry === "string" && entry.length > 0)
    ? pruneUndefined(actor) as CapabilityExecutionActorContract
    : undefined;
}

function normalizeStringArray(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => typeof entry === "string");
}

function normalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUnknown(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    const normalizedEntry = normalizeUnknown(entry);
    if (normalizedEntry === undefined) {
      continue;
    }
    normalized[key] = normalizedEntry;
  }
  return normalized;
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function withSha256Prefix(hash: string): string {
  return `sha256:${hash}`;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    result[key] = pruneUndefined(entry);
  }
  return result as T;
}
