// load_case.mjs — read-only case-event loader for agency-health.
// Reads the agency case event stream from the runx data.local JSON store
// (same contract as data-store's local fixture adapter) and emits the events
// array. This is a cli-tool shim because the data-store read_* runners are not
// yet supported by the native publish harness; it performs no writes.
//
// Inputs (RUNX_INPUTS_JSON): data_source_ref, case_id, store_id, limit
// Emits: { events: [...], aggregate_id, resource }

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveStorePath(inputs) {
  // data.local default root: .runx/data/local-sources/<store_id>.json
  const storeId = inputs.store_id || "agency-health";
  const cwd = process.env.RUNX_CWD || process.env.INIT_CWD || process.cwd();
  const candidates = [
    join(cwd, ".runx", "data", "local-sources", `${storeId}.json`),
    join(homedir(), ".runx", "data", "local-sources", `${storeId}.json`),
    join(cwd, "skills", "agency-health", "tools", `${storeId}.json`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function main() {
  const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
  const path = resolveStorePath(inputs);
  if (!path) {
    // No seeded store: return empty stream (read-only, never errors on miss).
    console.log(JSON.stringify({ events: [], aggregate_id: inputs.case_id, resource: "agency_cases" }));
    return;
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const aggregateId = inputs.case_id;
  const streams = doc.streams || doc.events || {};
  const stream = streams[aggregateId] || streams["agency_cases"] || [];
  const events = Array.isArray(stream) ? stream : (stream.events || []);
  const limit = inputs.limit || 500;
  console.log(JSON.stringify({ case_events: { events: events.slice(-limit), aggregate_id: aggregateId, resource: "agency_cases" } }));
}

main();
