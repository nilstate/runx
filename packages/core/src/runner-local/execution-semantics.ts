import {
  hashStable,
  type ExecutionSemantics,
  type GovernedDisposition,
  type ReceiptInputContext,
  type ReceiptOutcome,
  type ReceiptSurfaceRef,
} from "../receipts/index.js";

export interface NormalizedExecutionSemantics {
  readonly disposition: GovernedDisposition;
  readonly inputContext?: ReceiptInputContext;
  readonly outcomeState: ExecutionSemantics["outcome_state"] extends infer State ? NonNullable<State> : never;
  readonly outcome?: ReceiptOutcome;
  readonly surfaceRefs?: readonly ReceiptSurfaceRef[];
  readonly evidenceRefs?: readonly ReceiptSurfaceRef[];
}

const DEFAULT_INPUT_CONTEXT_MAX_BYTES = 4096;

export function normalizeExecutionSemantics(
  semantics: ExecutionSemantics | undefined,
  inputs: Readonly<Record<string, unknown>>,
): NormalizedExecutionSemantics {
  return {
    disposition: semantics?.disposition ?? "completed",
    inputContext: captureInputContext(semantics?.input_context, inputs),
    outcomeState: semantics?.outcome_state ?? "complete",
    outcome: semantics?.outcome,
    surfaceRefs: normalizeSurfaceRefs(semantics?.surface_refs),
    evidenceRefs: normalizeSurfaceRefs(semantics?.evidence_refs),
  };
}

export function mergeExecutionSemantics(
  base: ExecutionSemantics | undefined,
  override: ExecutionSemantics | undefined,
): ExecutionSemantics | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  return {
    disposition: override.disposition ?? base.disposition,
    outcome_state: override.outcome_state ?? base.outcome_state,
    outcome: override.outcome ?? base.outcome,
    input_context: override.input_context ?? base.input_context,
    surface_refs: override.surface_refs ?? base.surface_refs,
    evidence_refs: override.evidence_refs ?? base.evidence_refs,
  };
}

function captureInputContext(
  directive: ExecutionSemantics["input_context"] | undefined,
  inputs: Readonly<Record<string, unknown>>,
): ReceiptInputContext | undefined {
  if (!directive) {
    return undefined;
  }

  const snapshotSource = directive.snapshot ?? inputs;
  if (directive.capture === false && directive.snapshot === undefined) {
    return undefined;
  }

  const redacted = sanitizeInputContextValue(snapshotSource);
  const serialized = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(serialized);
  const maxBytes = directive.max_bytes ?? DEFAULT_INPUT_CONTEXT_MAX_BYTES;
  return {
    source: directive.source ?? "inputs",
    snapshot: bytes <= maxBytes ? redacted : undefined,
    preview: bytes <= maxBytes ? undefined : serialized.slice(0, maxBytes),
    bytes,
    max_bytes: maxBytes,
    truncated: bytes > maxBytes,
    value_hash: hashStable(redacted),
  };
}

function normalizeSurfaceRefs(
  refs: readonly ReceiptSurfaceRef[] | undefined,
): readonly ReceiptSurfaceRef[] | undefined {
  if (!refs || refs.length === 0) {
    return undefined;
  }
  return refs.map((ref) => ({
    type: ref.type,
    uri: ref.uri,
    label: ref.label,
  }));
}

function sanitizeInputContextValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeInputContextValue(entry));
  }
  if (typeof value === "string") {
    return "[redacted]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveInputContextKey(key) ? "[redacted]" : sanitizeInputContextValue(entry),
    ]),
  );
}

function isSensitiveInputContextKey(key: string): boolean {
  return /(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|raw[_-]?secret|raw[_-]?token)/i.test(
    key,
  );
}
