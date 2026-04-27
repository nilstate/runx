import { createHash } from "node:crypto";

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

export interface ThreadAdapterDescriptor {
  readonly type: string;
  readonly provider?: string;
  readonly surface?: string;
  readonly cursor?: string;
  readonly adapter_ref?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function requireDateTime(value: unknown, label: string): string {
  const stringValue = requireString(value, label);
  if (Number.isNaN(Date.parse(stringValue))) {
    throw new Error(`${label} must be an ISO datetime string.`);
  }
  return stringValue;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, label);
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireEnum(value, allowed, label);
}

export function optionalDateTime(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireDateTime(value, label);
}

export function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

export function optionalPlainRecord(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, label);
}

export function validateEvidenceRef(value: unknown, label: string): EvidenceRef {
  const record = requireRecord(value, label);
  return {
    type: requireString(record.type, `${label}.type`),
    uri: requireString(record.uri, `${label}.uri`),
    label: optionalString(record.label, `${label}.label`),
    recorded_at: optionalDateTime(record.recorded_at, `${label}.recorded_at`),
  };
}

export function optionalActor(value: unknown, label: string): Actor | undefined {
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

export function optionalEvidenceRef(value: unknown, label: string): EvidenceRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateEvidenceRef(value, label);
}

export function validateThreadAdapterDescriptor(value: unknown, label: string): ThreadAdapterDescriptor {
  const record = requireRecord(value, label);
  return {
    type: requireString(record.type, `${label}.type`),
    provider: optionalString(record.provider, `${label}.provider`),
    surface: optionalString(record.surface, `${label}.surface`),
    cursor: optionalString(record.cursor, `${label}.cursor`),
    adapter_ref: optionalString(record.adapter_ref, `${label}.adapter_ref`),
  };
}

export function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
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
