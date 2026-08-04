export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      pruned[key] = pruneUndefined(entry);
    }
  }
  return pruned as T;
}

export function prune<T>(value: T): T | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => prune(entry))
      .filter((entry) => entry !== undefined);
    return (items.length > 0 ? items : undefined) as T | undefined;
  }
  if (!isRecord(value)) {
    return value === undefined ? undefined : value;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => [key, prune(entry)] as const)
    .filter(([, entry]) => entry !== undefined);
  return (entries.length > 0 ? Object.fromEntries(entries) : undefined) as T | undefined;
}

export function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
