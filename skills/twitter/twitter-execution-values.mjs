export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function array(value) {
  return Array.isArray(value) ? value : [];
}

export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function activeThread(value) {
  if (value === null || value === undefined) return null;
  const candidate = record(value);
  const actIndex = nonNegativeInteger(candidate.act_index);
  const nextSegmentIndex = nonNegativeInteger(candidate.next_segment_index);
  const inReplyTo = text(candidate.in_reply_to);
  if (actIndex === null || nextSegmentIndex === null || !inReplyTo) return null;
  return {
    act_index: actIndex,
    next_segment_index: nextSegmentIndex,
    in_reply_to: inReplyTo,
  };
}
