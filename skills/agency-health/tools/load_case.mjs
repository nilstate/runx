// load_case.mjs — read-only case-event loader for agency-health.
// Resolves the data.local JSON store relative to THIS script so it works
// regardless of the runx harness working directory. Performs no writes.
//
// Inputs (RUNX_INPUTS_JSON): data_source_ref, case_id, store_id, limit
// Emits: { events: [...], aggregate_id, resource }

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function resolveStorePath(inputs) {
  const storeId = inputs.store_id || "agency-health";
  const candidates = [
    join(HERE, `${storeId}.json`),
    join(process.env.RUNX_CWD || process.cwd(), "skills", "agency-health", "tools", `${storeId}.json`),
    join(HERE, "..", "..", "..", "skills", "agency-health", "tools", `${storeId}.json`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function loadEvents(inputs) {
  const path = resolveStorePath(inputs);
  if (!path) return [];
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const aggregateId = inputs.case_id;
  const streams = doc.streams || doc.events || {};
  // Exact aggregate match only — a missing/tampered case yields an empty
  // stream, which the grader treats as "no readable case events".
  const stream = streams[aggregateId] || [];
  const events = Array.isArray(stream) ? stream : (stream.events || []);
  return events.slice(-(inputs.limit || 500));
}

function main() {
  const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
  const events = loadEvents(inputs);
  console.log(JSON.stringify({ events, aggregate_id: inputs.case_id, resource: "agency_cases" }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
