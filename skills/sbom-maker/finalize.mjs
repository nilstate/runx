#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { finalizeStoredResult } from "./lib.mjs";

try {
  const inputs = parseInputs();
  const generated = requiredObject(inputs.generated, "generated");
  const appendResult = requiredObject(inputs.append_result, "append_result");
  const readbackResult = requiredObject(inputs.readback_result, "readback_result");
  process.stdout.write(JSON.stringify(finalizeStoredResult({ generated, appendResult, readbackResult })));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { reason } })}\n`);
  process.exitCode = 1;
}

function parseInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON ?? "{}";
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNX_INPUTS_JSON must be an object");
  }
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is required`);
  return value;
}
