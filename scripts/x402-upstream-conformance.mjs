#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM_DIR = "/tmp/x402-upstream";
const DEFAULT_ENDPOINT = "/exact/evm/eip3009";
const EXPECTED_UPSTREAM_SHA = "230e6a9a7eebce22c911a0687d6f4e6d1ac019f7";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePin = readJson(path.join(repositoryRoot, "fixtures", "contracts", "x402-v2", "upstream-pin.json"));
const REQUIRED_ENV = [
  "SERVER_EVM_ADDRESS",
  "CLIENT_EVM_PRIVATE_KEY",
  "FACILITATOR_EVM_PRIVATE_KEY",
  // The current upstream e2e runner checks these before applying the EVM-only filter.
  "SERVER_SVM_ADDRESS",
  "CLIENT_SVM_PRIVATE_KEY",
  "FACILITATOR_SVM_PRIVATE_KEY",
];

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  usage(0);
}

const mode = args.includes("--run") ? "run" : "check";
const upstreamDir = option("--upstream-dir") || process.env.X402_UPSTREAM_DIR || DEFAULT_UPSTREAM_DIR;
const artifactDir =
  option("--artifact-dir") || process.env.RUNX_X402_CONFORMANCE_ARTIFACT_DIR || path.join(os.tmpdir(), "runx-x402-upstream-conformance");
const endpoint = option("--endpoint") || process.env.RUNX_X402_CONFORMANCE_ENDPOINT || DEFAULT_ENDPOINT;
const e2eDir = path.join(upstreamDir, "e2e");

const upstream = inspectUpstream(upstreamDir, e2eDir);
const sourceVerification = inspectSourcePins(upstreamDir, sourcePin.sources);
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
const command = buildCommand({ e2eDir, artifactDir, endpoint });
const pinMatches = upstream.sha === EXPECTED_UPSTREAM_SHA;
const report = {
  schema: "runx.x402.upstream_conformance.v1",
  mode,
  upstream_dir: upstreamDir,
  upstream_available: upstream.available,
  upstream_sha: upstream.sha,
  expected_upstream_sha: EXPECTED_UPSTREAM_SHA,
  pin_matches: pinMatches,
  source_pin_matches: sourceVerification.matches,
  source_pin_checked: sourceVerification.checked,
  source_pin_mismatches: sourceVerification.mismatches,
  artifact_dir: artifactDir,
  endpoint,
  required_env: REQUIRED_ENV,
  missing_env: missingEnv,
  command,
  can_run: upstream.available && pinMatches && sourceVerification.matches && missingEnv.length === 0,
  notes: [
    "This wraps the upstream x402 e2e runner; it does not patch or copy upstream protocol code into runx.",
    "The upstream mock-facilitator is startup-only and intentionally fails if /verify or /settle are called.",
    "Use dedicated funded testnet wallets only; the upstream e2e runner may move funds between configured wallets.",
  ],
};

if (mode === "check") {
  write(report);
  process.exit(upstream.available && pinMatches && sourceVerification.matches ? 0 : 1);
}

if (!upstream.available) {
  write(report);
  fail(`x402 upstream checkout not found at ${upstreamDir}`);
}
if (!pinMatches) {
  write(report);
  fail(`x402 upstream checkout must be pinned to ${EXPECTED_UPSTREAM_SHA}`);
}
if (!sourceVerification.matches) {
  write(report);
  fail("x402 upstream source files do not match the repo-owned SHA-256 pin");
}
if (missingEnv.length > 0) {
  write(report);
  fail(`missing required environment variables: ${missingEnv.join(", ")}`);
}

mkdirSync(artifactDir, { recursive: true });
writeFileSync(path.join(artifactDir, "x402-upstream-conformance-preflight.json"), `${JSON.stringify(report, null, 2)}\n`);

const result = spawnSync(command[0], command.slice(1), {
  cwd: e2eDir,
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);

function buildCommand({ e2eDir: dir, artifactDir: outDir, endpoint: endpointPath }) {
  return [
    "pnpm",
    "--dir",
    dir,
    "test",
    "--testnet",
    "--families=evm",
    "--versions=2",
    "--schemes=exact",
    "--clients=fetch",
    "--servers=express",
    "--facilitators=typescript",
    `--endpoints=${endpointPath}`,
    "--min",
    `--output-json=${path.join(outDir, "x402-upstream-e2e.json")}`,
    `--log=${path.join(outDir, "x402-upstream-e2e.log")}`,
  ];
}

function inspectUpstream(dir, e2e) {
  if (!existsSync(path.join(e2e, "package.json"))) {
    return { available: false, sha: null };
  }
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    available: result.status === 0,
    sha: result.status === 0 ? result.stdout.trim() : null,
  };
}

function inspectSourcePins(dir, sources) {
  if (!Array.isArray(sources)) {
    return { matches: false, checked: 0, mismatches: [{ path: null, reason: "pin_sources_missing" }] };
  }
  const root = path.resolve(dir);
  const mismatches = [];
  let checked = 0;
  for (const source of sources) {
    if (typeof source?.path !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(source?.digest ?? "")) {
      mismatches.push({ path: source?.path ?? null, reason: "invalid_pin_entry" });
      continue;
    }
    const sourcePath = path.resolve(root, source.path);
    if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
      mismatches.push({ path: source.path, reason: "path_outside_checkout" });
      continue;
    }
    if (!existsSync(sourcePath)) {
      mismatches.push({ path: source.path, reason: "source_missing" });
      continue;
    }
    const actual = `sha256:${createHash("sha256").update(readFileSync(sourcePath)).digest("hex")}`;
    checked += 1;
    if (actual !== source.digest) {
      mismatches.push({ path: source.path, reason: "digest_mismatch", expected: source.digest, actual });
    }
  }
  return { matches: checked === sources.length && mismatches.length === 0, checked, mismatches };
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read upstream pin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function option(name) {
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`x402-upstream-conformance: ${message}\n`);
  process.exit(1);
}

function usage(code) {
  process.stderr.write(
    [
      "usage:",
      "  node scripts/x402-upstream-conformance.mjs --check [--upstream-dir DIR] [--artifact-dir DIR]",
      "  node scripts/x402-upstream-conformance.mjs --run [--upstream-dir DIR] [--artifact-dir DIR]",
      "",
      "default upstream dir: /tmp/x402-upstream",
      "",
      "minimal official scenario:",
      "  pnpm test --testnet --families=evm --versions=2 --schemes=exact --clients=fetch --servers=express --facilitators=typescript --endpoints=/exact/evm/eip3009 --min",
    ].join("\n") + "\n",
  );
  process.exit(code);
}
