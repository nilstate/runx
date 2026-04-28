import {
  isRecord,
  optionalDateTime,
  optionalString,
  requireRecord,
  requireString,
} from "../util/index.js";

export {
  isAlreadyExists,
  isNotFound,
  isRecord,
} from "../util/types.js";
export {
  hashStable,
  stableStringify,
} from "../util/hash.js";
export {
  optionalDateTime,
  optionalEnum,
  optionalPlainRecord,
  optionalString,
  optionalStringArray,
  requireArray,
  requireDateTime,
  requireEnum,
  requireRecord,
  requireString,
} from "../util/validators.js";

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

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
