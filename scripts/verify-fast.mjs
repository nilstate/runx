#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const rustKernelBin = path.join(
  workspaceRoot,
  "crates",
  "target",
  "debug",
  process.platform === "win32" ? "runx.exe" : "runx",
);
const rustHarnessFixtureOracleBin = path.join(
  workspaceRoot,
  "crates",
  "target",
  "debug",
  process.platform === "win32" ? "runx-harness-fixture-oracles.exe" : "runx-harness-fixture-oracles",
);

const evalBinEnv = {
  RUNX_KERNEL_EVAL_BIN: rustKernelBin,
  RUNX_PARSER_EVAL_BIN: rustKernelBin,
  RUNX_RUST_CLI_BIN: rustKernelBin,
  RUNX_DEV_RUST_CLI_BIN: rustKernelBin,
  RUNX_HARNESS_FIXTURE_ORACLE_BIN: rustHarnessFixtureOracleBin,
  RUNX_RECEIPT_SIGN_KID: process.env.RUNX_RECEIPT_SIGN_KID ?? "verify-fast-test-key",
  RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64:
    process.env.RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64 ?? "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
  RUNX_RECEIPT_SIGN_ISSUER_TYPE: process.env.RUNX_RECEIPT_SIGN_ISSUER_TYPE ?? "hosted",
};
const rustBuildEnv = {
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? defaultCargoBuildJobs(),
};

const results = [];

await runParallelGroup("source checks", [
  step("readiness structural guard", "node", ["scripts/check-readiness-structural.mjs"]),
  step("demo inventory guard", "node", ["scripts/check-demo-inventory.mjs"]),
  step("boundary:check", "pnpm", ["boundary:check"]),
  step("test:boundary", "pnpm", ["test:boundary"]),
  step("typecheck", "pnpm", ["typecheck"]),
  step("bindings:check", "pnpm", ["bindings:check"]),
  step("command drift", "pnpm", ["commands:check-drift"]),
  step("public domain URLs", "pnpm", ["domains:check"]),
  step("release version sync", "pnpm", ["release:version:check"]),
  step("integration module guard", "node", ["scripts/check-integration-test-modules.mjs"]),
]);

await runSerialGroup("rust structure checks", [
  step("rust:crate-graph", "pnpm", ["rust:crate-graph"]),
  step("rust:style", "pnpm", ["rust:style"]),
  step("cutover:legacy-check", "pnpm", ["cutover:legacy-check"]),
]);

// One invocation for both binaries: the resolver unifies runx-runtime's feature
// set across the two packages, so its lib compiles once instead of twice with
// divergent feature fingerprints.
const rustBuild = await runStep(
  step("build rust binaries", cargo, [
    "build",
    "--quiet",
    "--manifest-path",
    "crates/Cargo.toml",
    "-p",
    "runx-cli",
    "-p",
    "runx-runtime",
    "--features",
    "runx-runtime/cli-tool",
    "--bin",
    "runx",
    "--bin",
    "runx-harness-fixture-oracles",
  ]),
  rustBuildEnv,
);

if (rustBuild.status === 0) {
  await runSerialGroup(
    "generated artifacts and fixtures",
    [
      step("build workspace", "node", ["scripts/build-workspace.mjs"]),
      step("authoring package contract", "node", ["scripts/check-authoring-package-contract.mjs"]),
      step("publishable manifests", "node", ["scripts/check-publishable-package-manifests.mjs"]),
      step("fixtures:kernel:validate", "pnpm", ["fixtures:kernel:validate"]),
      step("fixtures:kernel:check", "pnpm", ["fixtures:kernel:check"]),
      step("fixtures:kernel:keys", "pnpm", ["fixtures:kernel:keys"]),
      step("fixtures:contracts:check", "pnpm", ["fixtures:contracts:check"]),
      step("fixtures:contracts:keys", "pnpm", ["fixtures:contracts:keys"]),
      step("fixtures:harness:check", "pnpm", ["fixtures:harness:check"]),
      step("fixtures:harness:summary-check", "pnpm", ["fixtures:harness:summary-check"]),
      step("fixtures:adapters:a2a:check", "pnpm", ["fixtures:adapters:a2a:check"]),
      step("fixtures:adapters:agent:check", "pnpm", ["fixtures:adapters:agent:check"]),
      step("fixtures:cli-parity:check", "pnpm", ["fixtures:cli-parity:check"]),
      step("fixtures:cli-help:check", "pnpm", ["fixtures:cli-help:check"]),
      step("packet contracts", "pnpm", ["packet-schemas:check"]),
      step("docs:exit-codes", "pnpm", ["docs:exit-codes"]),
      step("doctor json", rustKernelBin, ["doctor", "--json"]),
      step("test:fast", "pnpm", ["test:fast"]),
    ],
    evalBinEnv,
  );
} else {
  console.error("Skipping eval-binary-dependent checks because a required Rust binary failed to build.");
}

printSummaryAndExit();

function step(name, command, args) {
  return { name, command, args };
}

function defaultCargoBuildJobs() {
  const available = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return String(Math.max(1, Math.min(available, 4)));
}

async function runSerialGroup(name, steps, envExtra = {}) {
  console.log(`\n== ${name} ==`);
  for (const current of steps) {
    await runStep(current, envExtra);
  }
}

async function runParallelGroup(name, steps, envExtra = {}) {
  console.log(`\n== ${name} ==`);
  await Promise.all(steps.map((current) => runStep(current, envExtra)));
}

function runStep(current, envExtra = {}) {
  const started = performance.now();
  console.log(`\n[verify:fast] start ${current.name}`);
  return new Promise((resolve) => {
    const child = spawn(current.command, current.args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...envExtra },
      stdio: "inherit",
    });
    child.on("close", (status, signal) => {
      const durationMs = Math.round(performance.now() - started);
      const result = {
        ...current,
        status: status ?? 1,
        signal,
        durationMs,
      };
      results.push(result);
      const label = result.status === 0 ? "pass" : "fail";
      const signalSuffix = signal ? ` signal=${signal}` : "";
      console.log(`[verify:fast] ${label} ${current.name} (${durationMs}ms)${signalSuffix}`);
      resolve(result);
    });
    child.on("error", (error) => {
      const durationMs = Math.round(performance.now() - started);
      const result = {
        ...current,
        status: 1,
        signal: undefined,
        durationMs,
        error,
      };
      results.push(result);
      console.log(`[verify:fast] fail ${current.name} (${durationMs}ms): ${error.message}`);
      resolve(result);
    });
  });
}

function printSummaryAndExit() {
  const failed = results.filter((result) => result.status !== 0);
  console.log("\n== verify:fast summary ==");
  for (const result of results) {
    const label = result.status === 0 ? "PASS" : "FAIL";
    console.log(`${label} ${result.name} ${result.durationMs}ms`);
  }
  if (failed.length > 0) {
    console.error(`\nverify:fast failed ${failed.length} required step(s):`);
    for (const result of failed) {
      console.error(`- ${result.name}`);
    }
    process.exit(1);
  }
}
