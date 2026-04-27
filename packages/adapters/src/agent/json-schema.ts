import type { OutputContract, OutputContractEntry } from "@runxhq/core/executor";
import type { SkillInput } from "@runxhq/core/parser";

import { FINAL_RESULT_TOOL_NAME } from "./types.js";
import { asRecord, isRecord, isString } from "./helpers.js";

export function skillInputsToJsonSchema(inputs: Readonly<Record<string, SkillInput>>): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [name, skillInputToJsonSchema(input)]),
  );
  const required = Object.entries(inputs)
    .filter(([, input]) => input.required)
    .map(([name]) => name);
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function skillInputToJsonSchema(input: SkillInput): Readonly<Record<string, unknown>> {
  const schema: Record<string, unknown> = {};
  const normalizedType = normalizeInputType(input.type);
  if (normalizedType) {
    schema.type = normalizedType;
  }
  if (input.description) {
    schema.description = input.description;
  }
  if (input.default !== undefined) {
    schema.default = input.default;
  }
  return schema;
}

export function normalizeInputType(type: string): string | undefined {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
    case "array":
      return type;
    default:
      return undefined;
  }
}

export function outputContractToJsonSchema(contract: OutputContract): Readonly<Record<string, unknown>> {
  const properties = Object.fromEntries(
    Object.entries(contract).map(([key, entry]) => [key, outputContractEntryToJsonSchema(entry)]),
  );
  const required = Object.entries(contract)
    .filter(([, entry]) => outputContractEntryRequired(entry))
    .map(([key]) => key);
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function outputContractEntryToJsonSchema(entry: OutputContractEntry): Readonly<Record<string, unknown>> {
  if (typeof entry === "string") {
    return simpleJsonSchemaForType(entry);
  }
  const record = asRecord(entry) ?? {};
  const type = typeof record.type === "string" ? record.type : Array.isArray(record.enum) ? "string" : undefined;
  const schema: Record<string, unknown> = type ? simpleJsonSchemaForType(type) : {};
  if (typeof record.description === "string") {
    schema.description = record.description;
  }
  if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string")) {
    schema.enum = record.enum;
  }
  if (type === "object" && schema.additionalProperties === undefined) {
    schema.additionalProperties = true;
  }
  if (type === "array" && schema.items === undefined) {
    schema.items = {};
  }
  return schema;
}

export function simpleJsonSchemaForType(type: string): Record<string, unknown> {
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return { type };
    case "array":
      return { type: "array", items: {} };
    case "object":
      return { type: "object", additionalProperties: true };
    default:
      return {};
  }
}

export function outputContractEntryRequired(entry: OutputContractEntry): boolean {
  if (typeof entry === "string") {
    return true;
  }
  return entry.required !== false;
}

export function validateFinalPayload(payload: unknown, contract: OutputContract | undefined): string | undefined {
  if (!contract) {
    return undefined;
  }
  const record = asRecord(payload);
  if (!record) {
    return `${FINAL_RESULT_TOOL_NAME} must receive a JSON object payload.`;
  }

  const unknownKeys = Object.keys(record).filter((key) => !(key in contract));
  if (unknownKeys.length > 0) {
    return `${FINAL_RESULT_TOOL_NAME} contained unexpected keys: ${unknownKeys.join(", ")}.`;
  }

  for (const [key, entry] of Object.entries(contract)) {
    const value = record[key];
    if (value === undefined) {
      if (outputContractEntryRequired(entry)) {
        return `${FINAL_RESULT_TOOL_NAME} is missing required field '${key}'.`;
      }
      continue;
    }
    const mismatch = validateOutputContractValue(value, entry, key);
    if (mismatch) {
      return mismatch;
    }
  }

  return undefined;
}

export function validateOutputContractValue(
  value: unknown,
  entry: OutputContractEntry,
  key: string,
): string | undefined {
  const spec = typeof entry === "string" ? { type: entry } : entry;
  const expectedType = typeof spec.type === "string" ? spec.type : Array.isArray(spec.enum) ? "string" : undefined;
  if (Array.isArray(spec.enum) && (!isString(value) || !spec.enum.includes(value))) {
    return `'${key}' must be one of ${spec.enum.join(", ")}.`;
  }
  if (!expectedType) {
    return undefined;
  }

  const valid =
    (expectedType === "string" && typeof value === "string")
    || (expectedType === "number" && typeof value === "number" && Number.isFinite(value))
    || (expectedType === "integer" && Number.isInteger(value))
    || (expectedType === "boolean" && typeof value === "boolean")
    || (expectedType === "array" && Array.isArray(value))
    || (expectedType === "object" && isRecord(value))
    || (expectedType === "null" && value === null);
  return valid ? undefined : `'${key}' must be ${expectedType}.`;
}
