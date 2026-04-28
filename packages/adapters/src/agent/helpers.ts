import path from "node:path";

import { asRecord, isPlainRecord as isRecord } from "@runxhq/core/util";

export { asRecord, isRecord };

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseJsonMaybe(value: string): unknown {
  if (!value.trim()) {
    return "";
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseJsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = parseJsonValue(value, label);
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return record;
}

export function extractApiErrorMessage(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return bodyText.trim() || "request failed";
  }
  return bodyText.trim() || "request failed";
}

export function sanitizeProviderToolName(toolName: string): string {
  const normalized = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 64) || "tool";
}

export function normalizeRequestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

export function parseConfiguredToolRoots(env: NodeJS.ProcessEnv | undefined): readonly string[] {
  return String(env?.RUNX_TOOL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => path.resolve(value));
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.length > 0)));
}

export function isToolErrorResult(value: unknown): boolean {
  return isRecord(value) && typeof value.error === "string";
}

export function packetSchemaFromOutput(value: unknown): string | undefined {
  return isRecord(value) && typeof value.schema === "string" ? value.schema : undefined;
}

export function unwrapPacketData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if ("data" in value) {
    return value.data;
  }
  return value;
}
