#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(workspaceRoot, "scripts", "verify-fast.mjs"), "utf8");
const parallelSourceGroup = sliceBetween(
  source,
  'await runParallelGroup("source checks"',
  'await runSerialGroup("rust structure checks"',
);

for (const forbidden of [
  "authoring package contract",
  "rust:crate-graph",
  "rust:style",
  "cutover:legacy-check",
  "build rust binaries",
  "test:fast",
]) {
  if (parallelSourceGroup.includes(forbidden)) {
    throw new Error(`verify:fast launches ${forbidden} inside the parallel source-check group`);
  }
}

for (const required of [
  'step("readiness structural guard"',
  'step("demo inventory guard"',
  'step("release version sync"',
  'await runSerialGroup("rust structure checks"',
  'step("cutover:legacy-check"',
  'step("build rust binaries"',
  'step("build workspace"',
  'step("authoring package contract"',
]) {
  if (!source.includes(required)) {
    throw new Error(`verify:fast is missing required serialized step marker: ${required}`);
  }
}

const buildWorkspaceIndex = source.indexOf('step("build workspace"');
for (const requiredAfterBuild of [
  'step("authoring package contract"',
]) {
  const stepIndex = source.indexOf(requiredAfterBuild);
  if (stepIndex < buildWorkspaceIndex) {
    throw new Error(`verify:fast runs ${requiredAfterBuild} before the workspace build`);
  }
}

console.log("verify:fast plan keeps release drift checks early, package checks after build, and Rust-heavy checks serialized.");

function sliceBetween(contents, start, end) {
  const startIndex = contents.indexOf(start);
  if (startIndex === -1) {
    throw new Error(`missing start marker: ${start}`);
  }
  const endIndex = contents.indexOf(end, startIndex);
  if (endIndex === -1) {
    throw new Error(`missing end marker: ${end}`);
  }
  return contents.slice(startIndex, endIndex);
}
