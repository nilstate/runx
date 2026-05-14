// These patterns catch output that exposes runx builder machinery instead of
// presenting native, reader-facing work. Add a pattern only when a reviewed
// artifact shows a repeatable framing leak; keep evaluator logic in quality.ts.
export const machineFramingPatterns = [
  /\bmachine output\b/i,
  /\bagent output\b/i,
  /\bmodel output\b/i,
  /\bAI-generated\b/i,
  /\bthe machine should\b/i,
  /\bthe agent should\b/i,
  /\bthe model should\b/i,
] as const;

export const builderFramingPatterns = [
  /\bsupplied catalog\b/i,
  /\bsupplied decomposition\b/i,
  /\bsupplied work-?plan\b/i,
  /\bprovided catalog evidence\b/i,
  /\bbuilder envelope\b/i,
  /\bmachine packet\b/i,
] as const;
