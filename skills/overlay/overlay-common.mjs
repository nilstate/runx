export function record(value) {
  return isRecord(value) ? value : {};
}

export function requiredRecord(value, field) {
  const parsed = record(value);
  if (Object.keys(parsed).length === 0) throw new Error(`${field} must be a non-empty object`);
  return parsed;
}

export function requiredString(value, field) {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`${field} must be a non-empty string`);
  return parsed;
}

export function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function strings(value) {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

export function uniqueStrings(value) {
  return [...new Set(strings(value))].sort();
}

export function records(value) {
  return Array.isArray(value) ? value.map(record) : [];
}

export function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function packageSegment(value, field) {
  const parsed = requiredString(value, field);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(parsed)) throw new Error(`${field} must be a lowercase package segment`);
  return parsed;
}

export function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

export function numberValue(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function boundedMessage(error) {
  return (error instanceof Error ? error.message : "Binding validation failed")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}
